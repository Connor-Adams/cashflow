import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RollupRow, Transaction } from './api-types';

test('RollupRow has the rollup shape', () => {
  const r: RollupRow = { categoryId: 1, currency: 'CAD', name: 'Work', path: 'Work', parentId: null, depth: 0, directTotal: 0, rolledTotal: 10 };
  assert.equal(r.rolledTotal, 10);
});

test('Transaction exposes category ids', () => {
  const ids: Pick<Transaction, 'categoryOverrideId' | 'finalCategoryId'> = { categoryOverrideId: 3, finalCategoryId: 3 };
  assert.equal(ids.finalCategoryId, 3);
});
