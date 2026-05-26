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
} from '../src/insights/detectors';
import type { DetectorTransaction, DetectorSettlement } from '../src/insights/detectors';

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
