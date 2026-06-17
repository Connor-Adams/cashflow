import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateSpendByCategory } from './budgets';

test('spend buckets carry finalCategoryId', () => {
  const rows = [
    { id: 1, currency: 'CAD', finalCategory: 'Fuel', finalCategoryId: 11, finalBusiness: false, finalSplitType: 'me', amount: -40, businessAmount: '0' },
  ];
  const out = aggregateSpendByCategory(rows as never);
  const bucket = [...out.values()].find((b) => b.category === 'Fuel');
  assert.ok(bucket);
  assert.equal((bucket as { categoryId?: number | null }).categoryId, 11);
});
