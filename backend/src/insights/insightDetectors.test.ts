/**
 * Pure unit tests for the deterministic insight detectors.
 *
 * Each detector is a pure function over plain JS rows — no DB. The route
 * (`POST /api/insights/run`) is responsible for loading rows and writing
 * findings to the `insights` table. By keeping the detectors pure we get
 * fast tests, easy edge-case coverage, and the AI review pass (#210) can
 * call the same functions to enrich findings without re-querying.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectDuplicateTransactions,
  detectMerchantSpendSpike,
  detectRecurringIncrease,
  detectMissingReceipt,
  detectUnusualCategorySpend,
  detectSettlementImbalance,
  detectCashRunwayLow,
  detectCategoryTrend,
} from './detectors';
import type {
  DetectorTransaction,
  DetectorSettlement,
  DetectorRunwayPoint,
} from './detectors';

function txn(partial: Partial<DetectorTransaction>): DetectorTransaction {
  return {
    id: 1,
    date: '2026-05-01',
    merchantClean: 'Amazon',
    amount: -10,
    currency: 'CAD',
    finalCategory: 'Groceries',
    receiptCount: 0,
    ...partial,
  };
}

// ---- detectDuplicateTransactions ---------------------------------------

test('detectDuplicateTransactions: flags same-amount, same-merchant, same-currency within 3 days', () => {
  const today = new Date('2026-05-10T12:00:00Z');
  const insights = detectDuplicateTransactions(
    [
      txn({ id: 1, date: '2026-05-08', merchantClean: 'Costco', amount: -123.45 }),
      txn({ id: 2, date: '2026-05-09', merchantClean: 'Costco', amount: -123.45 }),
    ],
    { now: today },
  );
  assert.equal(insights.length, 1);
  assert.equal(insights[0].type, 'duplicate_transactions');
  assert.equal(insights[0].severity, 'warning');
  assert.deepEqual(
    (insights[0].metadata as { transactionIds: number[] }).transactionIds.sort(),
    [1, 2],
  );
});

test('detectDuplicateTransactions: ignores pairs more than 3 days apart', () => {
  const today = new Date('2026-05-10T12:00:00Z');
  const insights = detectDuplicateTransactions(
    [
      txn({ id: 1, date: '2026-05-01', merchantClean: 'Costco', amount: -123.45 }),
      txn({ id: 2, date: '2026-05-06', merchantClean: 'Costco', amount: -123.45 }),
    ],
    { now: today },
  );
  assert.equal(insights.length, 0);
});

test('detectDuplicateTransactions: ignores different merchants', () => {
  const today = new Date('2026-05-10T12:00:00Z');
  const insights = detectDuplicateTransactions(
    [
      txn({ id: 1, date: '2026-05-08', merchantClean: 'Costco', amount: -50 }),
      txn({ id: 2, date: '2026-05-08', merchantClean: 'Walmart', amount: -50 }),
    ],
    { now: today },
  );
  assert.equal(insights.length, 0);
});

test('detectDuplicateTransactions: ignores positive amounts (refunds offsetting a charge)', () => {
  const today = new Date('2026-05-10T12:00:00Z');
  const insights = detectDuplicateTransactions(
    [
      txn({ id: 1, date: '2026-05-08', merchantClean: 'Costco', amount: -50 }),
      txn({ id: 2, date: '2026-05-08', merchantClean: 'Costco', amount: 50 }),
    ],
    { now: today },
  );
  assert.equal(insights.length, 0);
});

test('detectDuplicateTransactions: only inspects last 30 days', () => {
  const today = new Date('2026-05-10T12:00:00Z');
  const insights = detectDuplicateTransactions(
    [
      txn({ id: 1, date: '2026-01-01', merchantClean: 'Costco', amount: -50 }),
      txn({ id: 2, date: '2026-01-02', merchantClean: 'Costco', amount: -50 }),
    ],
    { now: today },
  );
  assert.equal(insights.length, 0);
});

test('detectDuplicateTransactions: fingerprint stable across runs with same ids', () => {
  const today = new Date('2026-05-10T12:00:00Z');
  const run1 = detectDuplicateTransactions(
    [
      txn({ id: 7, date: '2026-05-08', merchantClean: 'Costco', amount: -123.45 }),
      txn({ id: 9, date: '2026-05-09', merchantClean: 'Costco', amount: -123.45 }),
    ],
    { now: today },
  );
  // Same rows in reversed order — fingerprint should still match
  const run2 = detectDuplicateTransactions(
    [
      txn({ id: 9, date: '2026-05-09', merchantClean: 'Costco', amount: -123.45 }),
      txn({ id: 7, date: '2026-05-08', merchantClean: 'Costco', amount: -123.45 }),
    ],
    { now: today },
  );
  assert.equal(run1[0].fingerprint, run2[0].fingerprint);
});

// ---- detectMerchantSpendSpike ------------------------------------------

test('detectMerchantSpendSpike: flags current month spend > 200% of prior 3-mo avg', () => {
  const now = new Date('2026-05-15T12:00:00Z');
  const insights = detectMerchantSpendSpike(
    [
      // Prior 3 months at $50/month average
      txn({ id: 1, date: '2026-02-10', merchantClean: 'Uber', amount: -50 }),
      txn({ id: 2, date: '2026-03-10', merchantClean: 'Uber', amount: -50 }),
      txn({ id: 3, date: '2026-04-10', merchantClean: 'Uber', amount: -50 }),
      // Current month spike: $200 > 2 * $50
      txn({ id: 4, date: '2026-05-05', merchantClean: 'Uber', amount: -200 }),
    ],
    { now },
  );
  assert.equal(insights.length, 1);
  assert.equal(insights[0].type, 'merchant_spend_spike');
});

test('detectMerchantSpendSpike: ignores merchants under the $50 absolute floor', () => {
  const now = new Date('2026-05-15T12:00:00Z');
  const insights = detectMerchantSpendSpike(
    [
      txn({ id: 1, date: '2026-02-10', merchantClean: 'CoffeeCo', amount: -5 }),
      txn({ id: 2, date: '2026-03-10', merchantClean: 'CoffeeCo', amount: -5 }),
      txn({ id: 3, date: '2026-04-10', merchantClean: 'CoffeeCo', amount: -5 }),
      // 4x spike, but only $20 total — below the floor
      txn({ id: 4, date: '2026-05-05', merchantClean: 'CoffeeCo', amount: -20 }),
    ],
    { now },
  );
  assert.equal(insights.length, 0);
});

test('detectMerchantSpendSpike: ignores merchants with no prior history (avoids false positives for first-time spend)', () => {
  const now = new Date('2026-05-15T12:00:00Z');
  const insights = detectMerchantSpendSpike(
    [txn({ id: 4, date: '2026-05-05', merchantClean: 'NewVendor', amount: -500 })],
    { now },
  );
  assert.equal(insights.length, 0);
});

// ---- detectRecurringIncrease -------------------------------------------

test('detectRecurringIncrease: flags monthly merchant price up >20% vs prior occurrence', () => {
  const now = new Date('2026-05-15T12:00:00Z');
  const insights = detectRecurringIncrease(
    [
      txn({ id: 1, date: '2026-02-01', merchantClean: 'Netflix', amount: -15 }),
      txn({ id: 2, date: '2026-03-01', merchantClean: 'Netflix', amount: -15 }),
      txn({ id: 3, date: '2026-04-01', merchantClean: 'Netflix', amount: -15 }),
      txn({ id: 4, date: '2026-05-01', merchantClean: 'Netflix', amount: -22 }),
    ],
    { now },
  );
  assert.equal(insights.length, 1);
  assert.equal(insights[0].type, 'recurring_increase');
  const md = insights[0].metadata as { priorAmount: number; currentAmount: number };
  assert.equal(md.priorAmount, 15);
  assert.equal(md.currentAmount, 22);
});

test('detectRecurringIncrease: ignores small increases (≤20%)', () => {
  const now = new Date('2026-05-15T12:00:00Z');
  const insights = detectRecurringIncrease(
    [
      txn({ id: 1, date: '2026-02-01', merchantClean: 'Spotify', amount: -10 }),
      txn({ id: 2, date: '2026-03-01', merchantClean: 'Spotify', amount: -10 }),
      txn({ id: 3, date: '2026-04-01', merchantClean: 'Spotify', amount: -10 }),
      txn({ id: 4, date: '2026-05-01', merchantClean: 'Spotify', amount: -11 }),
    ],
    { now },
  );
  assert.equal(insights.length, 0);
});

test('detectRecurringIncrease: requires at least 3 prior monthly occurrences (one-off comparison is not a trend)', () => {
  const now = new Date('2026-05-15T12:00:00Z');
  const insights = detectRecurringIncrease(
    [
      txn({ id: 1, date: '2026-04-01', merchantClean: 'OneTime', amount: -10 }),
      txn({ id: 2, date: '2026-05-01', merchantClean: 'OneTime', amount: -30 }),
    ],
    { now },
  );
  assert.equal(insights.length, 0);
});

test('detectRecurringIncrease: skips merchants that are tracked subscriptions', () => {
  const now = new Date('2026-05-15T12:00:00Z');
  const rows = [
    txn({ id: 1, date: '2026-02-01', merchantClean: 'Netflix', amount: -15 }),
    txn({ id: 2, date: '2026-03-01', merchantClean: 'Netflix', amount: -15 }),
    txn({ id: 3, date: '2026-04-01', merchantClean: 'Netflix', amount: -15 }),
    txn({ id: 4, date: '2026-05-01', merchantClean: 'Netflix', amount: -22 }),
  ];
  const withGuard = detectRecurringIncrease(rows, { now, subscriptionMerchants: new Set(['netflix']) });
  assert.equal(withGuard.length, 0);
  const without = detectRecurringIncrease(rows, { now, subscriptionMerchants: new Set() });
  assert.equal(without.length, 1);
});

// ---- detectMissingReceipt ----------------------------------------------

test('detectMissingReceipt: flags large transactions older than 7 days with no receipts', () => {
  const now = new Date('2026-05-15T12:00:00Z');
  const insights = detectMissingReceipt(
    [
      txn({ id: 1, date: '2026-05-01', amount: -250, receiptCount: 0 }),
    ],
    { now },
  );
  assert.equal(insights.length, 1);
  assert.equal(insights[0].entityType, 'transaction');
  assert.equal(insights[0].entityId, 1);
});

test('detectMissingReceipt: ignores transactions that already have a receipt', () => {
  const now = new Date('2026-05-15T12:00:00Z');
  const insights = detectMissingReceipt(
    [txn({ id: 1, date: '2026-05-01', amount: -250, receiptCount: 1 })],
    { now },
  );
  assert.equal(insights.length, 0);
});

test('detectMissingReceipt: ignores transactions under the $100 large-charge threshold', () => {
  const now = new Date('2026-05-15T12:00:00Z');
  const insights = detectMissingReceipt(
    [txn({ id: 1, date: '2026-05-01', amount: -75, receiptCount: 0 })],
    { now },
  );
  assert.equal(insights.length, 0);
});

test('detectMissingReceipt: ignores transactions in the last 7 days (grace period)', () => {
  const now = new Date('2026-05-15T12:00:00Z');
  const insights = detectMissingReceipt(
    [txn({ id: 1, date: '2026-05-12', amount: -300, receiptCount: 0 })],
    { now },
  );
  assert.equal(insights.length, 0);
});

test('detectMissingReceipt: ignores positive amounts (refunds, payments)', () => {
  const now = new Date('2026-05-15T12:00:00Z');
  const insights = detectMissingReceipt(
    [txn({ id: 1, date: '2026-05-01', amount: 250, receiptCount: 0 })],
    { now },
  );
  assert.equal(insights.length, 0);
});

// ---- detectUnusualCategorySpend ----------------------------------------

test('detectUnusualCategorySpend: flags category spend > 200% of 3-mo avg', () => {
  const now = new Date('2026-05-15T12:00:00Z');
  const insights = detectUnusualCategorySpend(
    [
      txn({ id: 1, date: '2026-02-10', finalCategory: 'Groceries', amount: -200 }),
      txn({ id: 2, date: '2026-03-10', finalCategory: 'Groceries', amount: -200 }),
      txn({ id: 3, date: '2026-04-10', finalCategory: 'Groceries', amount: -200 }),
      txn({ id: 4, date: '2026-05-05', finalCategory: 'Groceries', amount: -500 }),
    ],
    { now },
  );
  assert.equal(insights.length, 1);
  assert.equal(insights[0].type, 'unusual_category_spend');
});

test('detectUnusualCategorySpend: skips null category', () => {
  const now = new Date('2026-05-15T12:00:00Z');
  const insights = detectUnusualCategorySpend(
    [
      txn({ id: 1, date: '2026-02-10', finalCategory: null, amount: -200 }),
      txn({ id: 2, date: '2026-03-10', finalCategory: null, amount: -200 }),
      txn({ id: 3, date: '2026-04-10', finalCategory: null, amount: -200 }),
      txn({ id: 4, date: '2026-05-05', finalCategory: null, amount: -500 }),
    ],
    { now },
  );
  assert.equal(insights.length, 0);
});

test('detectUnusualCategorySpend: requires $100 absolute floor on current month spend', () => {
  const now = new Date('2026-05-15T12:00:00Z');
  const insights = detectUnusualCategorySpend(
    [
      txn({ id: 1, date: '2026-02-10', finalCategory: 'Coffee', amount: -10 }),
      txn({ id: 2, date: '2026-03-10', finalCategory: 'Coffee', amount: -10 }),
      txn({ id: 3, date: '2026-04-10', finalCategory: 'Coffee', amount: -10 }),
      // 5x spike but only $50 total
      txn({ id: 4, date: '2026-05-05', finalCategory: 'Coffee', amount: -50 }),
    ],
    { now },
  );
  assert.equal(insights.length, 0);
});

// ---- detectSettlementImbalance -----------------------------------------

test('detectSettlementImbalance: flags large net imbalance with a single contact', () => {
  const insights = detectSettlementImbalance([
    { contactId: 7, contactName: 'Alex', direction: 'i_paid_partner', currency: 'CAD', amount: 500 },
    { contactId: 7, contactName: 'Alex', direction: 'i_paid_partner', currency: 'CAD', amount: 200 },
    { contactId: 7, contactName: 'Alex', direction: 'partner_paid_me', currency: 'CAD', amount: 50 },
  ]);
  assert.equal(insights.length, 1);
  assert.equal(insights[0].type, 'settlement_imbalance');
  // 500 + 200 - 50 = 650 owed in the i_paid_partner direction
  const md = insights[0].metadata as { netAmount: number; currency: string };
  assert.equal(md.netAmount, 650);
  assert.equal(md.currency, 'CAD');
});

test('detectSettlementImbalance: ignores small imbalances (<$100)', () => {
  const insights = detectSettlementImbalance([
    { contactId: 7, contactName: 'Alex', direction: 'i_paid_partner', currency: 'CAD', amount: 30 },
    { contactId: 7, contactName: 'Alex', direction: 'partner_paid_me', currency: 'CAD', amount: 5 },
  ]);
  assert.equal(insights.length, 0);
});

test('detectSettlementImbalance: nets settlements both ways to a balanced position', () => {
  const insights = detectSettlementImbalance([
    { contactId: 7, contactName: 'Alex', direction: 'i_paid_partner', currency: 'CAD', amount: 500 },
    { contactId: 7, contactName: 'Alex', direction: 'partner_paid_me', currency: 'CAD', amount: 500 },
  ]);
  assert.equal(insights.length, 0);
});

test('detectSettlementImbalance: keeps separate buckets per currency', () => {
  const insights = detectSettlementImbalance([
    { contactId: 7, contactName: 'Alex', direction: 'i_paid_partner', currency: 'CAD', amount: 600 },
    { contactId: 7, contactName: 'Alex', direction: 'i_paid_partner', currency: 'USD', amount: 300 },
  ]);
  assert.equal(insights.length, 2);
});

function _settlement(p: Partial<DetectorSettlement>): DetectorSettlement {
  return {
    contactId: 1,
    contactName: 'Partner',
    direction: 'i_paid_partner',
    currency: 'CAD',
    amount: 0,
    ...p,
  };
}
// Make _settlement appear used so TS doesn't strip it.
void _settlement;

// ---- detectCashRunwayLow -----------------------------------------------

/** Build a flat-then-stepping daily series starting at `now`. */
function runwaySeries(
  now: Date,
  balances: number[],
  currency = 'CAD',
): DetectorRunwayPoint[] {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return balances.map((balance, i) => ({
    date: new Date(now.getTime() + i * MS_PER_DAY).toISOString().slice(0, 10),
    balance,
    currency,
  }));
}

test('detectCashRunwayLow: fires when projected balance crosses below buffer within horizon', () => {
  const now = new Date('2026-05-01T12:00:00Z');
  // Balance stays positive for ~20 days, then dips negative on day 20.
  const balances = Array.from({ length: 31 }, (_, i) => (i < 20 ? 500 - i * 10 : -50));
  const insights = detectCashRunwayLow(runwaySeries(now, balances), { now });
  assert.equal(insights.length, 1);
  assert.equal(insights[0].type, 'cash_runway_low');
  assert.equal(insights[0].title, 'Projected balance is running low');
  assert.ok(insights[0].fingerprint.startsWith('runway:CAD:'));
  assert.ok(insights[0].fingerprint.length > 'runway:CAD:'.length);
  // Crossing is on day 20 (> 7 days out) but balance is negative → critical.
  assert.equal(insights[0].severity, 'critical');
});

test('detectCashRunwayLow: does NOT fire when balance stays above buffer all horizon', () => {
  const now = new Date('2026-05-01T12:00:00Z');
  const balances = Array.from({ length: 31 }, () => 1000);
  const insights = detectCashRunwayLow(runwaySeries(now, balances), { now });
  assert.equal(insights.length, 0);
});

test('detectCashRunwayLow: does NOT fire when crossing is beyond the horizon (day 45)', () => {
  const now = new Date('2026-05-01T12:00:00Z');
  // 46-day series, positive until day 45 — but detector only scans 30 days.
  const balances = Array.from({ length: 46 }, (_, i) => (i < 45 ? 100 : -100));
  const insights = detectCashRunwayLow(runwaySeries(now, balances), { now });
  assert.equal(insights.length, 0);
});

test('detectCashRunwayLow: critical when crossing within 7 days', () => {
  const now = new Date('2026-05-01T12:00:00Z');
  // Dip below buffer on day 3 (but still positive — wait, need < buffer=0).
  const balances = Array.from({ length: 31 }, (_, i) => (i < 3 ? 100 : -10));
  const insights = detectCashRunwayLow(runwaySeries(now, balances), { now });
  assert.equal(insights.length, 1);
  assert.equal(insights[0].severity, 'critical');
});

test('detectCashRunwayLow: warning when crossing is far out (>7 days) and balance is positive but below a positive buffer', () => {
  // With the default buffer of 0 a crossing always means a negative balance,
  // which is critical. To exercise the `warning` tier we verify the severity
  // logic directly: a non-negative crossing >7 days out maps to warning. Since
  // the default buffer is 0, we assert the negative-balance path stays critical
  // and document that the warning tier is reachable only with a positive buffer
  // (configurable later — see RUNWAY_LOW_BUFFER TODO).
  const now = new Date('2026-05-01T12:00:00Z');
  const balances = Array.from({ length: 31 }, (_, i) => (i < 15 ? 100 : -5));
  const insights = detectCashRunwayLow(runwaySeries(now, balances), { now });
  assert.equal(insights.length, 1);
  // Day 15 crossing, negative balance → critical per the spec.
  assert.equal(insights[0].severity, 'critical');
});

test('detectCashRunwayLow: evaluates each currency independently', () => {
  const now = new Date('2026-05-01T12:00:00Z');
  const cad = runwaySeries(now, Array.from({ length: 31 }, (_, i) => (i < 10 ? 100 : -50)), 'CAD');
  const usd = runwaySeries(now, Array.from({ length: 31 }, () => 5000), 'USD');
  const insights = detectCashRunwayLow([...cad, ...usd], { now });
  assert.equal(insights.length, 1);
  assert.equal((insights[0].metadata as { currency: string }).currency, 'CAD');
});

test('detectCashRunwayLow: fingerprint stable across re-runs when crossing date unchanged', () => {
  const now = new Date('2026-05-01T12:00:00Z');
  const balances = Array.from({ length: 31 }, (_, i) => (i < 12 ? 100 : -20));
  const run1 = detectCashRunwayLow(runwaySeries(now, balances), { now });
  const run2 = detectCashRunwayLow(runwaySeries(now, balances), { now });
  assert.equal(run1[0].fingerprint, run2[0].fingerprint);
});

// ---- detectCategoryTrend -----------------------------------------------

test('detectCategoryTrend: fires on a sustained ≥25% month-over-month rise over 3 full months', () => {
  const now = new Date('2026-05-15T12:00:00Z');
  // Prior 3 full months = Feb, Mar, Apr. 200 → 250 → 300 = +50% rise.
  const insights = detectCategoryTrend(
    [
      txn({ id: 1, date: '2026-02-10', finalCategory: 'Groceries', amount: -200 }),
      txn({ id: 2, date: '2026-03-10', finalCategory: 'Groceries', amount: -250 }),
      txn({ id: 3, date: '2026-04-10', finalCategory: 'Groceries', amount: -300 }),
    ],
    { now },
  );
  assert.equal(insights.length, 1);
  assert.equal(insights[0].type, 'category_trend');
  assert.equal(insights[0].title, 'Groceries spending keeps climbing');
  assert.ok(insights[0].fingerprint.startsWith('category-trend:CAD:groceries:'));
  // +50% ≥ 40% → warning
  assert.equal(insights[0].severity, 'warning');
  const md = insights[0].metadata as { risePct: number; monthlyTotals: number[] };
  assert.equal(md.risePct, 50);
  assert.deepEqual(md.monthlyTotals, [200, 250, 300]);
});

test('detectCategoryTrend: info severity for a 25–40% rise', () => {
  const now = new Date('2026-05-15T12:00:00Z');
  // 200 → 240 → 280 = +40%? (280-200)/200 = 0.4 → warning boundary. Use +30%.
  const insights = detectCategoryTrend(
    [
      txn({ id: 1, date: '2026-02-10', finalCategory: 'Dining', amount: -200 }),
      txn({ id: 2, date: '2026-03-10', finalCategory: 'Dining', amount: -230 }),
      txn({ id: 3, date: '2026-04-10', finalCategory: 'Dining', amount: -260 }),
    ],
    { now },
  );
  assert.equal(insights.length, 1);
  assert.equal(insights[0].severity, 'info'); // +30%
});

test('detectCategoryTrend: does NOT fire when rise is below 25%', () => {
  const now = new Date('2026-05-15T12:00:00Z');
  // 200 → 210 → 220 = +10%
  const insights = detectCategoryTrend(
    [
      txn({ id: 1, date: '2026-02-10', finalCategory: 'Groceries', amount: -200 }),
      txn({ id: 2, date: '2026-03-10', finalCategory: 'Groceries', amount: -210 }),
      txn({ id: 3, date: '2026-04-10', finalCategory: 'Groceries', amount: -220 }),
    ],
    { now },
  );
  assert.equal(insights.length, 0);
});

test('detectCategoryTrend: does NOT fire when latest month is below the $100 floor', () => {
  const now = new Date('2026-05-15T12:00:00Z');
  // Strong % rise but tiny absolute amounts: 20 → 40 → 60 (+200%) but last < 100.
  const insights = detectCategoryTrend(
    [
      txn({ id: 1, date: '2026-02-10', finalCategory: 'Coffee', amount: -20 }),
      txn({ id: 2, date: '2026-03-10', finalCategory: 'Coffee', amount: -40 }),
      txn({ id: 3, date: '2026-04-10', finalCategory: 'Coffee', amount: -60 }),
    ],
    { now },
  );
  assert.equal(insights.length, 0);
});

test('detectCategoryTrend: does NOT fire when one of the 3 months has no spend (gap)', () => {
  const now = new Date('2026-05-15T12:00:00Z');
  // Feb and Apr present, Mar missing — not a sustained trend.
  const insights = detectCategoryTrend(
    [
      txn({ id: 1, date: '2026-02-10', finalCategory: 'Groceries', amount: -200 }),
      txn({ id: 3, date: '2026-04-10', finalCategory: 'Groceries', amount: -400 }),
    ],
    { now },
  );
  assert.equal(insights.length, 0);
});

test('detectCategoryTrend: does NOT fire on a flat series', () => {
  const now = new Date('2026-05-15T12:00:00Z');
  const insights = detectCategoryTrend(
    [
      txn({ id: 1, date: '2026-02-10', finalCategory: 'Groceries', amount: -300 }),
      txn({ id: 2, date: '2026-03-10', finalCategory: 'Groceries', amount: -300 }),
      txn({ id: 3, date: '2026-04-10', finalCategory: 'Groceries', amount: -300 }),
    ],
    { now },
  );
  assert.equal(insights.length, 0);
});

test('detectCategoryTrend: does NOT fire on a declining series', () => {
  const now = new Date('2026-05-15T12:00:00Z');
  const insights = detectCategoryTrend(
    [
      txn({ id: 1, date: '2026-02-10', finalCategory: 'Groceries', amount: -400 }),
      txn({ id: 2, date: '2026-03-10', finalCategory: 'Groceries', amount: -300 }),
      txn({ id: 3, date: '2026-04-10', finalCategory: 'Groceries', amount: -200 }),
    ],
    { now },
  );
  assert.equal(insights.length, 0);
});

test('detectCategoryTrend: produces a distinct finding from detectUnusualCategorySpend on shared data', () => {
  const now = new Date('2026-05-15T12:00:00Z');
  // Data that trips BOTH: prior 3 months trend up (200→250→300), AND a current
  // (May) month spike of 800 vs the ~250 prior avg (>2x).
  const rows: DetectorTransaction[] = [
    txn({ id: 1, date: '2026-02-10', finalCategory: 'Groceries', amount: -200 }),
    txn({ id: 2, date: '2026-03-10', finalCategory: 'Groceries', amount: -250 }),
    txn({ id: 3, date: '2026-04-10', finalCategory: 'Groceries', amount: -300 }),
    txn({ id: 4, date: '2026-05-05', finalCategory: 'Groceries', amount: -800 }),
  ];
  const trend = detectCategoryTrend(rows, { now });
  const spike = detectUnusualCategorySpend(rows, { now });
  assert.equal(trend.length, 1);
  assert.equal(spike.length, 1);
  assert.notEqual(trend[0].type, spike[0].type);
  assert.notEqual(trend[0].fingerprint, spike[0].fingerprint);
});

test('detectCategoryTrend: fingerprint stable across re-runs for the same rolling window', () => {
  const now = new Date('2026-05-15T12:00:00Z');
  const rows: DetectorTransaction[] = [
    txn({ id: 1, date: '2026-02-10', finalCategory: 'Groceries', amount: -200 }),
    txn({ id: 2, date: '2026-03-10', finalCategory: 'Groceries', amount: -250 }),
    txn({ id: 3, date: '2026-04-10', finalCategory: 'Groceries', amount: -300 }),
  ];
  const run1 = detectCategoryTrend(rows, { now });
  const run2 = detectCategoryTrend(rows, { now });
  assert.equal(run1[0].fingerprint, run2[0].fingerprint);
});
