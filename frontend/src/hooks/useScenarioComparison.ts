import { useCallback, useEffect, useState } from 'react';
import { getJson } from '@/lib/api';
import type { ScenarioWithComputed } from './useScenarios';

interface UseScenarioComparisonResult {
  data: ScenarioWithComputed[];
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useScenarioComparison(ids: number[]): UseScenarioComparisonResult {
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
      `/api/tax/personal-scenarios/compare?ids=${idsKey}`,
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
  }, [idsKey, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { data, loading, error, reload };
}
