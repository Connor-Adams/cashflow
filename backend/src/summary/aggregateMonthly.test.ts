import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateMonthly,
  type MonthlyTxnRow,
} from './aggregateMonthly';
import type { ItemAllocationContext } from './loadItemAllocations';

function row(overrides: Partial<MonthlyTxnRow>): MonthlyTxnRow {
  return {
    id: 1,
    accountId: 1,
    date: '2026-05-10',
    currency: 'CAD',
    merchantRaw: 'M',
    merchantClean: 'M',
    finalCategory: 'Shopping',
    finalBusiness: false,
    finalSplitType: 'me',
    amount: '-100.00',
    txnType: 'purchase',
    businessAmount: '0',
    ...overrides,
  };
}

test('aggregateMonthly: points unchanged when no itemContext supplied', () => {
  const out = aggregateMonthly(
    [row({ id: 1, amount: '-50' }), row({ id: 2, amount: '-25', date: '2026-05-15' })],
    new Map(),
  );
  assert.equal(out.points.length, 1);
  assert.equal(out.points[0].sumAmount, -75);
  // Without items, categoryPoints still come from the single-bucket fallback
  // (one entry per row's finalCategory) — every row contributes its full
  // amount to its txn category.
  const shopping = out.categoryPoints.find((p) => p.category === 'Shopping');
  assert.ok(shopping);
  assert.equal(shopping.sumAmount, -75);
});

test('aggregateMonthly: itemContext drives per-category breakdown', () => {
  const itemContext: ItemAllocationContext = {
    linksByTxn: new Map([
      [
        1,
        [{ externalOrderId: 10, linkedAmount: '100.00' }],
      ],
    ]),
    ordersById: new Map([
      [
        10,
        {
          id: 10,
          subtotal: '100.00',
          tax: '0',
          shipping: null,
          total: '100.00',
          currency: 'CAD',
        },
      ],
    ]),
    itemsByOrder: new Map([
      [
        10,
        [
          {
            id: 1,
            totalPrice: '60.00',
            unitPrice: null,
            quantity: 1,
            inferredCategory: 'Office',
            categoryOverride: null,
            businessUsePercent: null,
            businessUseOverride: null,
          },
          {
            id: 2,
            totalPrice: '40.00',
            unitPrice: null,
            quantity: 1,
            inferredCategory: 'Groceries',
            categoryOverride: null,
            businessUsePercent: null,
            businessUseOverride: null,
          },
        ],
      ],
    ]),
  };
  const out = aggregateMonthly(
    [row({ id: 1, amount: '-100.00', finalCategory: 'Shopping' })],
    new Map(),
    itemContext,
  );
  // Top-line preserved.
  assert.equal(out.points.length, 1);
  assert.equal(out.points[0].sumAmount, -100);
  // Category breakdown follows items, not txn category.
  const office = out.categoryPoints.find((p) => p.category === 'Office');
  const groceries = out.categoryPoints.find((p) => p.category === 'Groceries');
  const shopping = out.categoryPoints.find((p) => p.category === 'Shopping');
  assert.ok(office, 'expected Office category point');
  assert.equal(office.sumAmount, -60);
  assert.ok(groceries, 'expected Groceries category point');
  assert.equal(groceries.sumAmount, -40);
  assert.equal(shopping, undefined, 'Shopping should not appear when items override it');
});

test('aggregateMonthly: excludes positive payments and non-categorical flows', () => {
  const out = aggregateMonthly(
    [
      row({ id: 1, date: '2026-06-01', amount: 20, txnType: 'payment' }),
      row({ id: 2, date: '2026-06-02', amount: -500, txnType: 'transfer' }),
      row({ id: 3, date: '2026-06-03', amount: -10, finalCategory: 'Dining' }),
    ],
    new Map(),
  );
  const jun = out.points.find((p) => p.month === '2026-06');
  assert.ok(jun);
  assert.equal(jun.sumAmount, -10);
  // Only the Dining row should appear in categoryPoints for June.
  const dining = out.categoryPoints.find((p) => p.category === 'Dining');
  assert.ok(dining);
  assert.equal(dining.sumAmount, -10);
  assert.equal(out.categoryPoints.length, 1);
});

test('aggregateMonthly: income (txnType=income) is excluded from both points and categoryPoints', () => {
  const out = aggregateMonthly(
    [
      row({ id: 1, date: '2026-05-02', amount: '-100', finalCategory: 'Dining' }),
      row({ id: 2, date: '2026-05-03', amount: '3000', txnType: 'income', finalCategory: null }),
    ],
    new Map(),
  );
  const may = out.points.find((p) => p.month === '2026-05');
  assert.ok(may);
  assert.equal(may.sumAmount, -100, 'income excluded from the activity curve');
  // No null/Uncategorized income bucket should appear in categoryPoints.
  assert.equal(out.categoryPoints.length, 1);
  assert.equal(out.categoryPoints[0].category, 'Dining');
  assert.equal(out.categoryPoints[0].sumAmount, -100);
  // Invariant: points[m,c] == sum of categoryPoints[m,c,*] must survive the peel.
  const catSum = out.categoryPoints.reduce((s, p) => s + p.sumAmount, 0);
  assert.equal(may.sumAmount, catSum);
});
