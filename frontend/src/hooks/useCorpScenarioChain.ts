import { useCallback, useEffect, useState } from 'react';
import { getJson } from '@/lib/api';
import type { CorpComputedReturn, CorpScenario } from './useCorpScenarios';

export interface CorpScenarioChainEntry {
  scenario: CorpScenario;
  /**
   * null when that year's return could not be computed. The backend isolates
   * per-year compute failures so one bad year (typically a projection past the
   * last encoded rate table) still returns 200 for the rest of the chain.
   */
  computed: CorpComputedReturn | null;
  /** The compute failure message for this year, or null when it computed. */
  error: string | null;
}

interface UseCorpScenarioChainResult {
  data: CorpScenarioChainEntry[] | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * Walks the multi-year corp scenario chain forward via `next_year_id` from
 * `id`'s year-N anchor, returning `[{scenario, computed}]` entries in year
 * order.
 *
 * Backed by `GET /api/tax/scenarios/corp/:id/chain`.
 *
 * When `id` is null, clears state and returns `data: null` without fetching.
 */
export function useCorpScenarioChain(id: number | null): UseCorpScenarioChainResult {
  const [data, setData] = useState<CorpScenarioChainEntry[] | null>(null);
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
    getJson<{ chain: CorpScenarioChainEntry[] }>(
      `/api/tax/scenarios/corp/${id}/chain`,
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
