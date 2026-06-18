import { useEffect, useState, useCallback } from 'react';
import { getCategoryTree } from './categoriesApi';
import type { CategoryTreeNode } from '../types/api';

export function useCategoryTree(): {
  tree: CategoryTreeNode[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const [tree, setTree] = useState<CategoryTreeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setTree(await getCategoryTree());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load categories');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  return { tree, loading, error, refresh };
}
