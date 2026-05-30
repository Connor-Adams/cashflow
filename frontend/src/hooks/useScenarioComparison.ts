import { useCallback, useEffect, useState } from 'react';
import { getJson } from '@/lib/api';
import type { ScenarioWithComputed } from './useScenarios';

interface UseScenarioComparisonResult {
  data: ScenarioWithComputed[];
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * Compare N scenarios via the backend's compare endpoint.
 *
 * The unified `/api/tax/scenarios/compare` endpoint dispatches on each
 * scenario's entity kind, so it works for personal, corp, or mixed sets.
 * The response shape (`{ scenarios: ScenarioWithComputed[] }`) is identical
 * regardless of kind.
 */
export function useScenarioComparison(
  ids: number[],
  endpoint = '/api/tax/scenarios/compare',
): UseScenarioComparisonResult {
  const [data, setData] = useState<ScenarioWithComputed[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const idsKey = ids.join(',');

  useEffect(() => {
    if (ids.length === 0) {
      setData([]);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    getJson<{ scenarios: ScenarioWithComputed[] }>(
      `${endpoint}?ids=${idsKey}`,
    )
      .then((d) => { if (!cancelled) { setData(d.scenarios); setLoading(false); } })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(String((e as Error)?.message ?? e));
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, endpoint, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { data, loading, error, reload };
}
