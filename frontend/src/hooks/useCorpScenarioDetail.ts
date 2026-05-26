import { useCallback, useEffect, useState } from 'react';
import { getJson } from '@/lib/api';
import type { CorpScenarioWithComputed } from './useCorpScenarios';

interface UseCorpScenarioDetailResult {
  data: CorpScenarioWithComputed | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useCorpScenarioDetail(id: number | null): UseCorpScenarioDetailResult {
  const [data, setData] = useState<CorpScenarioWithComputed | null>(null);
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
    getJson<CorpScenarioWithComputed>(`/api/tax/corp-scenarios/${id}`)
      .then((d) => { if (!cancelled) { setData(d); setLoading(false); } })
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
