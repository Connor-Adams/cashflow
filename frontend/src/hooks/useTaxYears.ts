import { useEffect, useState } from 'react';
import { getJson } from '../lib/api';

export function useTaxYears() {
  const [years, setYears] = useState<number[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    getJson<{ years: number[] }>('/api/tax/years')
      .then((d) => { if (!cancelled) setYears(d.years); })
      .catch((e) => { if (!cancelled) setError(String(e?.message ?? e)); });
    return () => { cancelled = true; };
  }, []);
  return { years, error };
}
