import type { TaxOutlookDto } from '@cashflow/shared';
import { useCallback, useEffect, useState } from 'react';
import { getJson } from '@/lib/api';

interface UseTaxOutlookResult {
  data: TaxOutlookDto | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * The year's instalment obligation, balance-due date and run-rate forward view.
 *
 * Keyed on the year alone, not on a scenario: the outlook is computed from the
 * entity's actual facts across a three-year window, so scenario overrides cannot
 * move it and re-fetching when the active scenario changes would be waste.
 *
 * The endpoint is deliberately uncached server-side — the projection moves as the
 * calendar advances with no fact changing — so `reload` exists for callers that want
 * a fresh read after an import.
 */
export function useTaxOutlook(year: number): UseTaxOutlookResult {
  const [data, setData] = useState<TaxOutlookDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getJson<TaxOutlookDto>(`/api/tax/personal/${year}/outlook`)
      .then((d) => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(String((e as Error)?.message ?? e));
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [year, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { data, loading, error, reload };
}
