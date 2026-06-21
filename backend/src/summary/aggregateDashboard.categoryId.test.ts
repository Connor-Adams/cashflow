import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateDashboard } from './aggregateDashboard';

test('dashboard category breakdown carries finalCategoryId', () => {
  const rows = [
    {
      id: 1,
      accountId: 1,
      date: '2026-01-15',
      currency: 'CAD',
      finalCategory: 'Dining',
      finalCategoryId: 9,
      finalBusiness: false,
      finalSplitType: 'me',
      merchantRaw: null,
      merchantClean: null,
      merchantCanonical: null,
      amount: -25,
      reviewFlag: false,
      txnType: null,
    },
  ];
  const res = aggregateDashboard(rows as never, new Map() as never);
  // byCategory is a Map — find the Dining bucket
  const cats = res.byCategory;
  const dining = [...cats.values()].find((c) => c.category === 'Dining');
  assert.ok(dining, 'Dining bucket present');
  assert.equal((dining as { categoryId?: number | null }).categoryId, 9);
});
