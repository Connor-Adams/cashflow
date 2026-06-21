// backend/src/summary/aggregateMonthly.categoryId.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateMonthly } from './aggregateMonthly';

test('category points carry finalCategoryId', () => {
  const rows = [
    { id: 1, accountId: 1, date: '2026-01-15', currency: 'CAD', merchantRaw: null, merchantClean: null,
      finalCategory: 'Groceries', finalCategoryId: 42, finalBusiness: false, finalSplitType: 'me', amount: -50, txnType: null },
  ];
  const res = aggregateMonthly(rows as never, new Map());
  const pt = res.categoryPoints.find((p: { category: string | null }) => p.category === 'Groceries');
  assert.ok(pt);
  assert.equal((pt as { categoryId: number | null }).categoryId, 42);
});
