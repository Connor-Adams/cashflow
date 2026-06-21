import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as api from './api';
import { getCategoryTree, resolveCategoryPath, flattenTreeToPaths } from './categoriesApi';
import type { CategoryTreeNode } from '../types/api';

const tree: CategoryTreeNode[] = [
  { id: 1, name: 'Work', parentId: null, icon: null, taxTreatment: 'none', children: [
    { id: 2, name: 'Expenses', parentId: 1, icon: null, taxTreatment: 'none', children: [
      { id: 3, name: 'Internet', parentId: 2, icon: null, taxTreatment: 'none', children: [] },
    ]},
  ]},
  { id: 4, name: 'Groceries', parentId: null, icon: null, taxTreatment: 'none', children: [] },
];

describe('categoriesApi', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('flattenTreeToPaths returns full paths sorted', () => {
    expect(flattenTreeToPaths(tree)).toEqual([
      'Groceries', 'Work', 'Work / Expenses', 'Work / Expenses / Internet',
    ]);
  });

  it('getCategoryTree hits /api/categories/tree', async () => {
    const spy = vi.spyOn(api, 'getJson').mockResolvedValue(tree);
    const out = await getCategoryTree();
    expect(spy).toHaveBeenCalledWith('/api/categories/tree');
    expect(out[0].name).toBe('Work');
  });

  it('resolveCategoryPath posts the path', async () => {
    const spy = vi.spyOn(api, 'postJson').mockResolvedValue({ id: 3, name: 'Internet', path: 'Work / Expenses / Internet', createdIds: [] });
    const out = await resolveCategoryPath('Work / Expenses / Internet');
    expect(spy).toHaveBeenCalledWith('/api/categories/resolve-path', { path: 'Work / Expenses / Internet' });
    expect(out.id).toBe(3);
  });
});
