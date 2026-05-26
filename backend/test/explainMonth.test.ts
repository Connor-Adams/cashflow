/**
 * Unit tests for the pure "explain this month" aggregator (Cashflow #225).
 *
 * Integration coverage (HTTP route, household isolation, optional AI summary
 * degradation) lives in test/integration/explainMonth.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  explainMonth,
  previousMonth,
  monthBounds,
  type ExplainMonthSubRow,
  type ExplainMonthTxnRow,
} from '../src/summary/explainMonth';

function txn(overrides: Partial<ExplainMonthTxnRow> = {}): ExplainMonthTxnRow {
  return {
    id: 1,
    date: '2026-05-15',
    currency: 'CAD',
    amount: '-25.00',
    finalCategory: 'Groceries',
    finalBusiness: false,
    merchantClean: 'Loblaws',
    merchantRaw: 'LOBLAWS #1234',
    reviewFlag: false,
    receiptCount: 0,
    ...overrides,
  };
}

function sub(overrides: Partial<ExplainMonthSubRow> = {}): ExplainMonthSubRow {
  return {
    id: 1,
    merchantName: 'Netflix',
    currency: 'CAD',
    amount: 15.99,
    cadence: 'monthly',
    annualizedCost: 191.88,
    status: 'active',
    priceChangeDetected: false,
    category: 'Streaming',
    lastChargeDate: '2026-05-10',
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

test('previousMonth handles January rollover', () => {
  assert.equal(previousMonth('2026-01'), '2025-12');
  assert.equal(previousMonth('2026-05'), '2026-04');
  assert.equal(previousMonth('2026-12'), '2026-11');
});

test('previousMonth returns input unchanged for malformed inputs', () => {
  assert.equal(previousMonth('not-a-month'), 'not-a-month');
});

test('monthBounds returns first-and-last day, accounting for varying month lengths', () => {
  assert.deepEqual(monthBounds('2026-02'), { from: '2026-02-01', to: '2026-02-28' });
  // 2024 was a leap year.
  assert.deepEqual(monthBounds('2024-02'), { from: '2024-02-01', to: '2024-02-29' });
  assert.deepEqual(monthBounds('2026-05'), { from: '2026-05-01', to: '2026-05-31' });
});

test('explainMonth returns empty result when no transactions present', () => {
  const result = explainMonth({
    month: '2026-05',
    currentTxns: [],
    previousTxns: [],
    subscriptions: [],
    currency: null,
  });
  assert.equal(result.month, '2026-05');
  assert.equal(result.previousMonth, '2026-04');
  assert.deepEqual(result.monthOverMonth, []);
  assert.deepEqual(result.findings, []);
  assert.equal(result.aiSummary, null);
});

test('monthOverMonth: positive amounts go to income, negative to spend', () => {
  const result = explainMonth({
    month: '2026-05',
    currentTxns: [
      txn({ id: 1, amount: '-100', finalCategory: 'Groceries' }),
      txn({ id: 2, amount: '50', finalCategory: 'Refund' }),
    ],
    previousTxns: [],
    subscriptions: [],
    currency: null,
  });
  const cad = result.monthOverMonth.find((m) => m.currency === 'CAD');
  assert.ok(cad);
  assert.equal(cad!.currentSpend, 100);
  assert.equal(cad!.currentIncome, 50);
  assert.equal(cad!.netCurrent, -50);
});

test('monthOverMonth: byCategory captures MoM deltas in sorted order', () => {
  const result = explainMonth({
    month: '2026-05',
    currentTxns: [
      txn({ id: 1, amount: '-200', finalCategory: 'Groceries' }),
      txn({ id: 2, amount: '-50', finalCategory: 'Coffee' }),
    ],
    previousTxns: [
      txn({ id: 11, date: '2026-04-10', amount: '-100', finalCategory: 'Groceries' }),
      txn({ id: 12, date: '2026-04-12', amount: '-150', finalCategory: 'Coffee' }),
    ],
    subscriptions: [],
    currency: null,
  });
  const cad = result.monthOverMonth.find((m) => m.currency === 'CAD');
  assert.ok(cad);
  // Groceries: -200 vs -100, delta = -100 (decreased by 100 i.e. signed amount went down)
  // Coffee: -50 vs -150, delta = 100 (signed went up i.e. less spend)
  // Sorted by abs delta desc — both equal 100, deterministic ordering by insertion.
  const groc = cad!.byCategory.find((c) => c.category === 'Groceries');
  assert.ok(groc);
  assert.equal(groc!.current, -200);
  assert.equal(groc!.previous, -100);
  assert.equal(groc!.delta, -100);
  const coffee = cad!.byCategory.find((c) => c.category === 'Coffee');
  assert.ok(coffee);
  assert.equal(coffee!.delta, 100);
});

test('explainMonth emits spend_change findings for top movers', () => {
  const result = explainMonth({
    month: '2026-05',
    currentTxns: [
      txn({ id: 1, amount: '-300', finalCategory: 'Groceries' }),
    ],
    previousTxns: [
      txn({ id: 11, date: '2026-04-10', amount: '-100', finalCategory: 'Groceries' }),
    ],
    subscriptions: [],
    currency: null,
  });
  const spendChanges = result.findings.filter((f) => f.kind === 'spend_change');
  assert.equal(spendChanges.length, 1);
  const f = spendChanges[0];
  assert.equal(f.currency, 'CAD');
  // signed delta on Groceries went from -100 to -300 = -200 (more spend)
  assert.equal(f.monthlyImpact, -200);
  assert.equal(f.severity, 'medium');
  assert.equal(f.transactionFilter.category, 'Groceries');
  assert.equal(f.transactionFilter.dateFrom, '2026-05-01');
  assert.equal(f.transactionFilter.dateTo, '2026-05-31');
});

test('explainMonth respects spendChangeLimit', () => {
  const cats = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
  const currentTxns = cats.map((c, i) =>
    txn({ id: i + 1, amount: `-${(i + 1) * 10}`, finalCategory: c }),
  );
  const result = explainMonth({
    month: '2026-05',
    currentTxns,
    previousTxns: [],
    subscriptions: [],
    currency: null,
    spendChangeLimit: 3,
  });
  const spendChanges = result.findings.filter((f) => f.kind === 'spend_change');
  assert.equal(spendChanges.length, 3);
});

test('explainMonth emits missing_receipt finding for big-ticket spend with no receipt', () => {
  const result = explainMonth({
    month: '2026-05',
    currentTxns: [
      txn({ id: 1, amount: '-200', merchantClean: 'Best Buy', receiptCount: 0 }),
      txn({ id: 2, amount: '-15', merchantClean: 'Starbucks', receiptCount: 0 }),
      txn({ id: 3, amount: '-500', merchantClean: 'Apple', receiptCount: 1 }),
    ],
    previousTxns: [],
    subscriptions: [],
    currency: null,
  });
  const missing = result.findings.filter((f) => f.kind === 'missing_receipt');
  assert.equal(missing.length, 1);
  assert.equal(missing[0].supportingTransactionIds[0], 1);
  assert.equal(missing[0].transactionFilter.merchant, 'Best Buy');
});

test('explainMonth missingReceiptThreshold override is respected', () => {
  const result = explainMonth({
    month: '2026-05',
    currentTxns: [
      txn({ id: 1, amount: '-30', merchantClean: 'Best Buy', receiptCount: 0 }),
    ],
    previousTxns: [],
    subscriptions: [],
    currency: null,
    missingReceiptThreshold: 25,
  });
  const missing = result.findings.filter((f) => f.kind === 'missing_receipt');
  assert.equal(missing.length, 1);
});

test('explainMonth emits subscription_change for new subscription this month', () => {
  const result = explainMonth({
    month: '2026-05',
    currentTxns: [],
    previousTxns: [],
    subscriptions: [
      sub({
        id: 7,
        merchantName: 'Acme SaaS',
        amount: 10,
        annualizedCost: 120,
        createdAt: '2026-05-15T12:00:00Z',
        updatedAt: '2026-05-15T12:00:00Z',
      }),
    ],
    currency: null,
  });
  const subs = result.findings.filter((f) => f.kind === 'subscription_change');
  assert.equal(subs.length, 1);
  assert.match(subs[0].title, /Acme SaaS.*new this month/);
  // New monthly sub at $10/mo costs the user $10 → impact recorded as -10
  assert.equal(subs[0].monthlyImpact, -10);
});

test('explainMonth emits subscription_change for cancellation this month', () => {
  const result = explainMonth({
    month: '2026-05',
    currentTxns: [],
    previousTxns: [],
    subscriptions: [
      sub({
        id: 3,
        merchantName: 'Old SaaS',
        amount: 12,
        annualizedCost: 144,
        status: 'cancelled',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2026-05-10T00:00:00Z',
      }),
    ],
    currency: null,
  });
  const subs = result.findings.filter((f) => f.kind === 'subscription_change');
  assert.equal(subs.length, 1);
  assert.match(subs[0].title, /Old SaaS.*cancelled this month/);
  // Cancellation = positive impact (saved money) → +12
  assert.equal(subs[0].monthlyImpact, 12);
});

test('explainMonth emits subscription_change for price increase detected this month', () => {
  const result = explainMonth({
    month: '2026-05',
    currentTxns: [],
    previousTxns: [],
    subscriptions: [
      sub({
        id: 9,
        merchantName: 'Netflix',
        amount: 18.99,
        annualizedCost: 227.88,
        priceChangeDetected: true,
        lastChargeDate: '2026-05-05',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2026-05-05T00:00:00Z',
      }),
    ],
    currency: null,
  });
  const subs = result.findings.filter((f) => f.kind === 'subscription_change');
  assert.equal(subs.length, 1);
  assert.match(subs[0].summary, /price changed/);
});

test('explainMonth skips subscription_change when nothing changed this month', () => {
  const result = explainMonth({
    month: '2026-05',
    currentTxns: [],
    previousTxns: [],
    subscriptions: [
      sub({
        id: 1,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        lastChargeDate: '2026-05-10', // active charge, but not new/cancelled/price-up
      }),
    ],
    currency: null,
  });
  const subs = result.findings.filter((f) => f.kind === 'subscription_change');
  assert.equal(subs.length, 0);
});

test('explainMonth emits review_needed aggregate per currency', () => {
  const result = explainMonth({
    month: '2026-05',
    currentTxns: [
      txn({ id: 1, amount: '-30', reviewFlag: true, currency: 'CAD' }),
      txn({ id: 2, amount: '-50', reviewFlag: true, currency: 'CAD' }),
      txn({ id: 3, amount: '-20', reviewFlag: true, currency: 'USD' }),
      txn({ id: 4, amount: '-10', reviewFlag: false, currency: 'CAD' }),
    ],
    previousTxns: [],
    subscriptions: [],
    currency: null,
  });
  const reviews = result.findings.filter((f) => f.kind === 'review_needed');
  assert.equal(reviews.length, 2);
  const cad = reviews.find((r) => r.currency === 'CAD');
  assert.ok(cad);
  assert.equal(cad!.supportingTransactionIds.length, 2);
  assert.equal(cad!.meta.count, 2);
  assert.equal(cad!.transactionFilter.reviewFlag, true);
});

test('explainMonth currency filter applies to monthOverMonth and findings', () => {
  const result = explainMonth({
    month: '2026-05',
    currentTxns: [
      txn({ id: 1, amount: '-100', currency: 'CAD' }),
      txn({ id: 2, amount: '-200', currency: 'USD' }),
    ],
    previousTxns: [
      txn({ id: 11, date: '2026-04-10', amount: '-50', currency: 'CAD' }),
      txn({ id: 12, date: '2026-04-10', amount: '-30', currency: 'USD' }),
    ],
    subscriptions: [],
    currency: 'CAD',
  });
  assert.equal(result.monthOverMonth.length, 1);
  assert.equal(result.monthOverMonth[0].currency, 'CAD');
  for (const f of result.findings) {
    assert.equal(f.currency, 'CAD');
  }
});

test('explainMonth emits business_summary with delta', () => {
  const result = explainMonth({
    month: '2026-05',
    currentTxns: [
      txn({ id: 1, amount: '-300', finalBusiness: true, finalCategory: 'Office' }),
    ],
    previousTxns: [
      txn({ id: 11, date: '2026-04-10', amount: '-100', finalBusiness: true, finalCategory: 'Office' }),
    ],
    subscriptions: [],
    currency: null,
  });
  const biz = result.findings.find((f) => f.kind === 'business_summary');
  assert.ok(biz);
  // business spend went from 100 to 300 → delta +200 ⇒ medium severity
  assert.equal(biz!.monthlyImpact, 200);
  assert.equal(biz!.severity, 'medium');
  assert.equal(biz!.transactionFilter.businessOnly, true);
});

test('explainMonth aiSummary defaults to null (the route fills it in)', () => {
  const result = explainMonth({
    month: '2026-05',
    currentTxns: [txn()],
    previousTxns: [],
    subscriptions: [],
    currency: null,
  });
  assert.equal(result.aiSummary, null);
});

test('explainMonth: missing_receipt sorts by amount desc', () => {
  const result = explainMonth({
    month: '2026-05',
    currentTxns: [
      txn({ id: 1, amount: '-75', merchantClean: 'A', receiptCount: 0 }),
      txn({ id: 2, amount: '-200', merchantClean: 'B', receiptCount: 0 }),
      txn({ id: 3, amount: '-100', merchantClean: 'C', receiptCount: 0 }),
    ],
    previousTxns: [],
    subscriptions: [],
    currency: null,
  });
  const missing = result.findings.filter((f) => f.kind === 'missing_receipt');
  assert.equal(missing.length, 3);
  assert.equal(missing[0].supportingTransactionIds[0], 2); // 200 first
  assert.equal(missing[1].supportingTransactionIds[0], 3); // 100 next
  assert.equal(missing[2].supportingTransactionIds[0], 1); // 75 last
});
