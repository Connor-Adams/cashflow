import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import * as catApi from './categoriesApi';
import { useCategoryPaths, _resetCategoryPathsCacheForTest } from './useCategoryPaths';
import type { CategoryTreeNode } from '../types/api';

const tree: CategoryTreeNode[] = [
  { id: 1, name: 'Work', parentId: null, icon: null, taxTreatment: 'none', children: [
    { id: 2, name: 'Internet', parentId: 1, icon: null, taxTreatment: 'none', children: [] },
  ]},
];

describe('useCategoryPaths', () => {
  beforeEach(() => { vi.restoreAllMocks(); _resetCategoryPathsCacheForTest(); });

  it('exposes full paths from the tree', async () => {
    vi.spyOn(catApi, 'getCategoryTree').mockResolvedValue(tree);
    const { result } = renderHook(() => useCategoryPaths());
    await waitFor(() => expect(result.current.paths).toContain('Work / Internet'));
    expect(result.current.paths).toContain('Work');
  });

  it('fetches once across instances', async () => {
    const spy = vi.spyOn(catApi, 'getCategoryTree').mockResolvedValue(tree);
    const a = renderHook(() => useCategoryPaths());
    const b = renderHook(() => useCategoryPaths());
    await waitFor(() => expect(a.result.current.paths.length).toBeGreaterThan(0));
    await waitFor(() => expect(b.result.current.paths.length).toBeGreaterThan(0));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
