import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import * as catApi from './categoriesApi';
import { useCategoryTree } from './useCategoryTree';
import type { CategoryTreeNode } from '../types/api';

const tree: CategoryTreeNode[] = [
  { id: 1, name: 'Work', parentId: null, icon: null, taxTreatment: 'none', children: [] },
];

describe('useCategoryTree', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('loads the tree on mount', async () => {
    vi.spyOn(catApi, 'getCategoryTree').mockResolvedValue(tree);
    const { result } = renderHook(() => useCategoryTree());
    await waitFor(() => expect(result.current.tree).toHaveLength(1));
    expect(result.current.tree[0].name).toBe('Work');
    expect(result.current.loading).toBe(false);
  });

  it('refresh re-fetches', async () => {
    const spy = vi.spyOn(catApi, 'getCategoryTree').mockResolvedValue(tree);
    const { result } = renderHook(() => useCategoryTree());
    await waitFor(() => expect(result.current.tree).toHaveLength(1));
    await act(async () => { await result.current.refresh(); });
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
