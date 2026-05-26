/**
 * Unit tests for the pure merchant-timeline aggregator.
 *
 * Aggregator is `backend/src/summary/merchantTimeline.ts`. It takes a
 * pre-filtered row set (the route applies visibility + merchant where
 * clauses) plus an optional receipt-presence Set and returns totals,
 * monthly trend, category breakdown, receipt coverage, and recurring
 * flag.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateMerchantTimeline,
  resolveMerchantKey,
  type MerchantTimelineTxnRow,
} from '../src/summary/merchantTimeline';

function row(over: Partial<MerchantTimelineTxnRow> = {}): MerchantTimelineTxnRow {
  return {
    id: 1,
    accountId: 1,
    date: '2026-01-15',
    currency: 'CAD',
    finalCategory: 'Groceries',
    finalBusiness: false,
    finalSplitType: 'me',
    merchantRaw: 'TIM HORTONS',
    merchantClean: 'TIM HORTONS',
    merchantCanonical: 'Tim Hortons',
    amount: '-12.50',
    txnType: 'purchase',
    isRecurring: false,
    accountType: 'credit_card',
    ...over,
  };
}

test('totals: spend, credits, count, average, first/last dates', () => {
  const rows: MerchantTimelineTxnRow[] = [
    row({ id: 1, date: '2026-01-01', amount: '-10.00' }),
    row({ id: 2, date: '2026-02-15', amount: '-20.00' }),
    row({ id: 3, date: '2026-03-01', amount: '5.00', txnType: 'refund' }), // credit
  ];
  const out = aggregateMerchantTimeline(rows);
  assert.equal(out.totals.totalSpend, 30);
  assert.equal(out.totals.totalCredits, 5);
  assert.equal(out.totals.netSpend, 25);
  assert.equal(out.totals.transactionCount, 3);
  assert.equal(out.totals.averageTransaction, 30 / 2, 'avg ignores credits, divides by spend count');
  assert.equal(out.totals.firstDate, '2026-01-01');
  assert.equal(out.totals.lastDate, '2026-03-01');
});

test('empty input: zeroed totals and empty arrays', () => {
  const out = aggregateMerchantTimeline([]);
  assert.equal(out.totals.totalSpend, 0);
  assert.equal(out.totals.transactionCount, 0);
  assert.equal(out.totals.averageTransaction, 0);
  assert.equal(out.totals.firstDate, null);
  assert.equal(out.totals.lastDate, null);
  assert.deepEqual(out.monthlyTrend, []);
  assert.deepEqual(out.byCategory, []);
  assert.equal(out.receiptCoverage.totalCount, 0);
  assert.equal(out.receiptCoverage.coverageByCount, 0);
  assert.equal(out.isRecurring, false);
});

test('monthly trend buckets rows by YYYY-MM and sorts ascending', () => {
  const rows: MerchantTimelineTxnRow[] = [
    row({ date: '2026-03-15', amount: '-10' }),
    row({ date: '2026-03-20', amount: '-15' }),
    row({ date: '2026-01-01', amount: '-5' }),
    row({ date: '2026-02-10', amount: '-7' }),
  ];
  const out = aggregateMerchantTimeline(rows);
  assert.deepEqual(
    out.monthlyTrend.map((m) => m.month),
    ['2026-01', '2026-02', '2026-03'],
  );
  const march = out.monthlyTrend.find((m) => m.month === '2026-03');
  assert.ok(march);
  assert.equal(march.totalSpend, 25);
  assert.equal(march.transactionCount, 2);
});

test('byCategory sums amounts per finalCategory, including null bucket, sorted by spend desc', () => {
  const rows: MerchantTimelineTxnRow[] = [
    row({ amount: '-30', finalCategory: 'Groceries' }),
    row({ amount: '-10', finalCategory: 'Dining' }),
    row({ amount: '-50', finalCategory: 'Groceries' }),
    row({ amount: '-5', finalCategory: null }),
  ];
  const out = aggregateMerchantTimeline(rows);
  assert.equal(out.byCategory.length, 3);
  assert.equal(out.byCategory[0].category, 'Groceries');
  assert.equal(out.byCategory[0].totalSpend, 80);
  assert.equal(out.byCategory[0].transactionCount, 2);
  assert.equal(out.byCategory[1].category, 'Dining');
  assert.equal(out.byCategory[2].category, null);
  assert.equal(out.byCategory[2].totalSpend, 5);
});

test('receiptCoverage counts rows whose id is present in the receipt set', () => {
  const rows: MerchantTimelineTxnRow[] = [
    row({ id: 1, amount: '-10' }),
    row({ id: 2, amount: '-20' }),
    row({ id: 3, amount: '-30' }),
  ];
  const out = aggregateMerchantTimeline(rows, new Set<number>([1, 3]));
  assert.equal(out.receiptCoverage.totalCount, 3);
  assert.equal(out.receiptCoverage.withReceiptCount, 2);
  assert.equal(out.receiptCoverage.missingCount, 1);
  assert.equal(out.receiptCoverage.coverageByCount, 2 / 3);
});

test('isRecurring: true when any row.isRecurring is true', () => {
  const rows: MerchantTimelineTxnRow[] = [
    row({ id: 1, isRecurring: false }),
    row({ id: 2, isRecurring: true }),
  ];
  assert.equal(aggregateMerchantTimeline(rows).isRecurring, true);
  assert.equal(aggregateMerchantTimeline([row({ isRecurring: false })]).isRecurring, false);
});

test('non-spend rows (transfer/investment/dividend/payment) excluded from spend totals', () => {
  const rows: MerchantTimelineTxnRow[] = [
    row({ id: 1, amount: '-100', txnType: 'purchase' }),
    row({ id: 2, amount: '-50', txnType: 'transfer' }), // money movement, excluded
    row({ id: 3, amount: '-25', accountType: 'investment', txnType: null }), // investment account
    row({ id: 4, amount: '20', txnType: 'payment' }), // statement payment positive (excluded)
  ];
  const out = aggregateMerchantTimeline(rows);
  // Only the purchase row is spend; payment positive is also excluded from credits (per aggregateDashboard rules).
  assert.equal(out.totals.totalSpend, 100);
  assert.equal(out.totals.totalCredits, 0);
  assert.equal(out.totals.netSpend, 100);
  // All four rows still count as transactions for the merchant.
  assert.equal(out.totals.transactionCount, 4);
});

test('positive non-payment-pattern rows credit totalCredits (refund/reward/etc)', () => {
  const rows: MerchantTimelineTxnRow[] = [
    row({ id: 1, amount: '-50', txnType: 'purchase' }),
    row({ id: 2, amount: '5', txnType: 'refund', merchantRaw: 'Tim Hortons Refund' }),
  ];
  const out = aggregateMerchantTimeline(rows);
  assert.equal(out.totals.totalSpend, 50);
  assert.equal(out.totals.totalCredits, 5);
  assert.equal(out.totals.netSpend, 45);
});

test('resolveMerchantKey: canonical || clean || raw fallback, trimmed', () => {
  assert.equal(
    resolveMerchantKey({
      merchantCanonical: ' Starbucks ',
      merchantClean: 'STARBUCKS #123',
      merchantRaw: 'SQ *STARBUCKS #123',
    }),
    'Starbucks',
  );
  assert.equal(
    resolveMerchantKey({
      merchantCanonical: null,
      merchantClean: ' STARBUCKS #123 ',
      merchantRaw: 'SQ *STARBUCKS #123',
    }),
    'STARBUCKS #123',
  );
  assert.equal(
    resolveMerchantKey({
      merchantCanonical: null,
      merchantClean: '',
      merchantRaw: ' RAW MERCHANT ',
    }),
    'RAW MERCHANT',
  );
  assert.equal(
    resolveMerchantKey({
      merchantCanonical: '',
      merchantClean: null,
      merchantRaw: null,
    }),
    '(unknown merchant)',
  );
});
