import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CategoryTreeNode, ResolvedCategoryPath } from './api-types';

test('CategoryTreeNode + ResolvedCategoryPath are usable, recursive shapes', () => {
  const node: CategoryTreeNode = {
    id: 1, name: 'Work', parentId: null, icon: null, taxTreatment: 'none',
    children: [{ id: 2, name: 'Internet', parentId: 1, icon: null, taxTreatment: 'none', children: [] }],
  };
  const resolved: ResolvedCategoryPath = { id: 2, name: 'Internet', path: 'Work / Internet', createdIds: [] };
  assert.equal(node.children[0].id, 2);
  assert.equal(resolved.id, 2);
});
