import { test } from 'node:test';
import assert from 'node:assert/strict';
import { netSpendByCurrencyCategory } from './categorySpend';
import { aggregateDashboard, type AccountRow, type SummaryTxnRow } from './aggregateDashboard';

test('nets signed amounts per (currency, categoryId) before converting to spend', () => {
  // byCategory fans one category across (business, split) buckets: a −200
  // shared purchase and a +50 personal refund land in different buckets.
  const out = netSpendByCurrencyCategory([
    { currency: 'CAD', categoryId: 5, sumAmount: -200 },
    { currency: 'CAD', categoryId: 5, sumAmount: 50 },
  ]);
  assert.equal(out.get('CAD')?.get(5), 150);
});

test('a net-refunded category shows negative spend (matches categoryReports netSpend)', () => {
  const out = netSpendByCurrencyCategory([
    { currency: 'CAD', categoryId: 7, sumAmount: -50 },
    { currency: 'CAD', categoryId: 7, sumAmount: 80 },
  ]);
  assert.equal(out.get('CAD')?.get(7), -30);
});

test('keeps currencies separate and skips null categoryIds', () => {
  const out = netSpendByCurrencyCategory([
    { currency: 'CAD', categoryId: 1, sumAmount: -10 },
    { currency: 'USD', categoryId: 1, sumAmount: -20 },
    { currency: 'CAD', categoryId: null, sumAmount: -999 },
  ]);
  assert.equal(out.get('CAD')?.get(1), 10);
  assert.equal(out.get('USD')?.get(1), 20);
  assert.equal(out.get('CAD')?.size, 1);
});

test('dashboard category-tree input reconciles with the headline netSpend', () => {
  const accounts = new Map<number, AccountRow>([
    [1, { id: 1, name: 'A', shortCode: null, accountType: 'chequing' }],
  ]);
  const base: SummaryTxnRow = {
    id: 1,
    accountId: 1,
    date: '2026-05-10',
    currency: 'CAD',
    finalCategory: 'Groceries',
    finalCategoryId: 5,
    finalBusiness: false,
    finalSplitType: 'shared',
    merchantRaw: 'M',
    merchantClean: 'M',
    merchantCanonical: 'M',
    amount: '-200.00',
    reviewFlag: false,
    txnType: 'purchase',
    businessAmount: '0',
  };
  const agg = aggregateDashboard(
    [base, { ...base, id: 2, amount: '50.00', txnType: 'refund', finalSplitType: 'me' }],
    accounts,
  );
  const tree = netSpendByCurrencyCategory(Array.from(agg.byCategory.values()));
  assert.equal(agg.metricsByCurrency.get('CAD')?.netSpend, 150);
  assert.equal(tree.get('CAD')?.get(5), 150);
});
