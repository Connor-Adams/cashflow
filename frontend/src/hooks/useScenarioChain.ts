import { useCallback, useEffect, useState } from 'react';
import { getJson } from '@/lib/api';
import type { ComputedReturn, Scenario } from './useScenarios';

export interface ScenarioChainEntry {
  scenario: Scenario;
  computed: ComputedReturn;
}

interface UseScenarioChainResult {
  data: ScenarioChainEntry[] | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * Walks the multi-year scenario chain forward via `next_year_id` from `id`'s
 * year-N anchor, returning `[{scenario, computed}]` entries in year order.
 *
 * Backed by `GET /api/tax/personal-scenarios/:id/chain`.
 *
 * When `id` is null, clears state and returns `data: null` without fetching.
 */
export function useScenarioChain(id: number | null): UseScenarioChainResult {
  const [data, setData] = useState<ScenarioChainEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (id === null) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    getJson<{ chain: ScenarioChainEntry[] }>(
      `/api/tax/scenarios/${id}/chain`,
    )
      .then((d) => { if (!cancelled) { setData(d.chain); setLoading(false); } })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(String((e as Error)?.message ?? e));
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [id, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { data, loading, error, reload };
}
