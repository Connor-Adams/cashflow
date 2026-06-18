import { useEffect, useState, useCallback } from 'react';
import { getCategoryTree, flattenTreeToPaths } from './categoriesApi';

type Listener = (paths: string[]) => void;
let cache: string[] | null = null;
let inflight: Promise<string[]> | null = null;
const listeners = new Set<Listener>();

export function _resetCategoryPathsCacheForTest(): void {
  cache = null; inflight = null; listeners.clear();
}

async function load(force = false): Promise<string[]> {
  if (!force && cache) return cache;
  if (!force && inflight) return inflight;
  inflight = getCategoryTree()
    .then((tree) => {
      const paths = flattenTreeToPaths(tree);
      cache = paths;
      for (const l of listeners) l(paths);
      return paths;
    })
    .finally(() => { inflight = null; });
  return inflight;
}

export function useCategoryPaths(): { paths: string[]; refresh: () => Promise<void> } {
  const [paths, setPaths] = useState<string[]>(cache ?? []);
  useEffect(() => {
    listeners.add(setPaths);
    load().then(setPaths).catch(() => {/* refresh() can retry */});
    return () => { listeners.delete(setPaths); };
  }, []);
  const refresh = useCallback(async () => { setPaths(await load(true)); }, []);
  return { paths, refresh };
}
