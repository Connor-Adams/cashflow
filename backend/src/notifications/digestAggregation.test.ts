/**
 * Pure-function unit tests for `aggregateDigest` (issue #267). No DB; we feed
 * the aggregator hand-crafted row arrays and assert the summary numbers
 * match expectations.
 *
 * Coverage:
 *   - empty week → isEmptyWeek=true, totals=0, no biggest txn
 *   - spend totals correctly exclude transfer/investment/dividend/payment
 *   - income totals correctly include income/refund/reward, exclude payments
 *   - top 3 categories ranked by absolute spend, ties broken sensibly
 *   - prior-week delta values
 *   - biggest transaction is the most-negative single row
 *   - currency picks the dominant-spend currency
 *   - investment-account rows are excluded entirely
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateDigest, computeReportingWeek, type DigestTxnRow } from './digest';

function row(overrides: Partial<DigestTxnRow>): DigestTxnRow {
  return {
    id: 1,
    date: '2026-05-26',
    amount: '-10.00',
    currency: 'CAD',
    merchantClean: 'Test',
    merchantRaw: 'TEST',
    finalCategory: 'Groceries',
    txnType: 'purchase',
    accountType: 'checking',
    reviewFlag: false,
    ...overrides,
  };
}

test('computeReportingWeek: Monday 09:00 UTC tick → last Mon–Sun', () => {
  const asOf = new Date('2026-05-25T09:00:00Z'); // Monday
  const { weekStart, weekEnd, priorStart, priorEnd } = computeReportingWeek(asOf);
  assert.equal(weekEnd, '2026-05-24'); // previous Sunday
  assert.equal(weekStart, '2026-05-18'); // previous Monday
  assert.equal(priorEnd, '2026-05-17');
  assert.equal(priorStart, '2026-05-11');
});

test('computeReportingWeek: Sunday tick → today is weekEnd', () => {
  const asOf = new Date('2026-05-24T09:00:00Z'); // Sunday
  const { weekStart, weekEnd } = computeReportingWeek(asOf);
  assert.equal(weekEnd, '2026-05-24');
  assert.equal(weekStart, '2026-05-18');
});

test('aggregateDigest: empty week → isEmptyWeek=true, totals=0', () => {
  const d = aggregateDigest([], [], {
    weekStart: '2026-05-18',
    weekEnd: '2026-05-24',
    hasAnyHistory: true,
    pendingCount: 0,
    fallbackCurrency: 'CAD',
  });
  assert.equal(d.isEmptyWeek, true);
  assert.equal(d.totalSpend, 0);
  assert.equal(d.totalIncome, 0);
  assert.equal(d.topCategories.length, 0);
  assert.equal(d.biggestTransaction, null);
  assert.equal(d.currency, 'CAD');
});

test('aggregateDigest: sums spend (negative purchase amounts)', () => {
  const current = [
    row({ id: 1, amount: '-25.00', finalCategory: 'Groceries' }),
    row({ id: 2, amount: '-15.50', finalCategory: 'Coffee' }),
    row({ id: 3, amount: '-9.50', finalCategory: 'Groceries' }),
  ];
  const d = aggregateDigest(current, [], {
    weekStart: '2026-05-18',
    weekEnd: '2026-05-24',
    hasAnyHistory: true,
    pendingCount: 0,
  });
  assert.equal(d.isEmptyWeek, false);
  assert.equal(d.totalSpend, 50);
  assert.equal(d.totalIncome, 0);
});

test('aggregateDigest: excludes transfer/investment/dividend/payment from spend', () => {
  const current = [
    row({ id: 1, amount: '-25.00', txnType: 'purchase' }),
    row({ id: 2, amount: '-100.00', txnType: 'transfer' }),
    row({ id: 3, amount: '-50.00', txnType: 'investment' }),
    row({ id: 4, amount: '-30.00', txnType: 'payment' }),
    row({ id: 5, amount: '-10.00', accountType: 'investment' }),
  ];
  const d = aggregateDigest(current, [], {
    weekStart: '2026-05-18',
    weekEnd: '2026-05-24',
    hasAnyHistory: true,
    pendingCount: 0,
  });
  // Only id=1 should count
  assert.equal(d.totalSpend, 25);
});

test('aggregateDigest: sums income from positive income/refund/reward but not payment', () => {
  const current = [
    row({ id: 1, amount: '500.00', txnType: 'income', finalCategory: null }),
    row({ id: 2, amount: '20.00', txnType: 'refund', finalCategory: null }),
    row({ id: 3, amount: '5.00', txnType: 'reward', finalCategory: null }),
    row({ id: 4, amount: '300.00', txnType: 'payment', finalCategory: null }), // excluded
    row({ id: 5, amount: '100.00', txnType: 'transfer', finalCategory: null }), // excluded
  ];
  const d = aggregateDigest(current, [], {
    weekStart: '2026-05-18',
    weekEnd: '2026-05-24',
    hasAnyHistory: true,
    pendingCount: 0,
  });
  assert.equal(d.totalIncome, 525);
});

test('aggregateDigest: top 3 categories by spend with prior delta', () => {
  const current = [
    row({ id: 1, amount: '-100.00', finalCategory: 'Groceries' }),
    row({ id: 2, amount: '-200.00', finalCategory: 'Dining' }),
    row({ id: 3, amount: '-300.00', finalCategory: 'Rent' }),
    row({ id: 4, amount: '-50.00', finalCategory: 'Misc' }),
  ];
  const prior = [
    row({ id: 10, amount: '-150.00', finalCategory: 'Groceries' }),
    row({ id: 11, amount: '-100.00', finalCategory: 'Dining' }),
    row({ id: 12, amount: '-300.00', finalCategory: 'Rent' }),
  ];
  const d = aggregateDigest(current, prior, {
    weekStart: '2026-05-18',
    weekEnd: '2026-05-24',
    hasAnyHistory: true,
    pendingCount: 0,
  });
  assert.equal(d.topCategories.length, 3);
  // Sorted by current total descending: Rent (300), Dining (200), Groceries (100)
  assert.equal(d.topCategories[0].category, 'Rent');
  assert.equal(d.topCategories[0].total, 300);
  assert.equal(d.topCategories[0].delta, 0);
  assert.equal(d.topCategories[1].category, 'Dining');
  assert.equal(d.topCategories[1].total, 200);
  assert.equal(d.topCategories[1].delta, 100);
  assert.equal(d.topCategories[2].category, 'Groceries');
  assert.equal(d.topCategories[2].total, 100);
  assert.equal(d.topCategories[2].delta, -50);
});

test('aggregateDigest: biggest transaction is most-negative row', () => {
  const current = [
    row({ id: 1, amount: '-25.00', merchantClean: 'Coffee Co' }),
    row({ id: 2, amount: '-2500.00', merchantClean: 'Rent Payment' }),
    row({ id: 3, amount: '-100.00', merchantClean: 'Groceries' }),
  ];
  const d = aggregateDigest(current, [], {
    weekStart: '2026-05-18',
    weekEnd: '2026-05-24',
    hasAnyHistory: true,
    pendingCount: 0,
  });
  assert.ok(d.biggestTransaction);
  assert.equal(d.biggestTransaction?.id, 2);
  assert.equal(d.biggestTransaction?.amount, -2500);
  assert.equal(d.biggestTransaction?.merchant, 'Rent Payment');
});

test('aggregateDigest: currency picked is dominant-spend currency', () => {
  const current = [
    row({ id: 1, amount: '-100.00', currency: 'USD' }),
    row({ id: 2, amount: '-50.00', currency: 'CAD' }),
    row({ id: 3, amount: '-150.00', currency: 'USD' }),
  ];
  const d = aggregateDigest(current, [], {
    weekStart: '2026-05-18',
    weekEnd: '2026-05-24',
    hasAnyHistory: true,
    pendingCount: 0,
  });
  assert.equal(d.currency, 'USD');
  assert.equal(d.totalSpend, 250);
});

test('aggregateDigest: budgets passed through', () => {
  const d = aggregateDigest([], [], {
    weekStart: '2026-05-18',
    weekEnd: '2026-05-24',
    hasAnyHistory: true,
    pendingCount: 5,
    budgets: [
      {
        budgetId: 1,
        name: 'Groceries',
        amount: 500,
        spent: 450,
        remaining: 50,
        currency: 'CAD',
      },
    ],
  });
  assert.equal(d.pendingCount, 5);
  assert.equal(d.budgets.length, 1);
  assert.equal(d.budgets[0].name, 'Groceries');
  assert.equal(d.budgets[0].remaining, 50);
});

test('aggregateDigest: uncategorized rows surface as "Uncategorized"', () => {
  const current = [
    row({ id: 1, amount: '-100.00', finalCategory: null }),
  ];
  const d = aggregateDigest(current, [], {
    weekStart: '2026-05-18',
    weekEnd: '2026-05-24',
    hasAnyHistory: true,
    pendingCount: 0,
  });
  assert.equal(d.topCategories[0].category, 'Uncategorized');
});

test('aggregateDigest: cross-currency top categories filtered to chosen currency', () => {
  const current = [
    row({ id: 1, amount: '-100.00', finalCategory: 'A', currency: 'USD' }),
    row({ id: 2, amount: '-200.00', finalCategory: 'B', currency: 'USD' }),
    row({ id: 3, amount: '-500.00', finalCategory: 'C', currency: 'CAD' }),
    // chosen currency is CAD (highest spend volume)
  ];
  const d = aggregateDigest(current, [], {
    weekStart: '2026-05-18',
    weekEnd: '2026-05-24',
    hasAnyHistory: true,
    pendingCount: 0,
  });
  assert.equal(d.currency, 'CAD');
  // Only C should appear (filtered to chosen currency).
  assert.equal(d.topCategories.length, 1);
  assert.equal(d.topCategories[0].category, 'C');
});
