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

// --- Multi-year comparison ---

export type TaxYearSummary = {
  year: number;
  computedAt: string;
  totals: Record<string, string>;
};

export function useTaxYearCompare(from: number, to: number) {
  const [years, setYears] = useState<TaxYearSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getJson<TaxYearSummary[] | { years: TaxYearSummary[] }>(
      `/api/tax/personal/years?from=${from}&to=${to}`,
    )
      .then((d) => {
        if (!cancelled) {
          setYears(Array.isArray(d) ? d : d.years ?? []);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(String(e?.message ?? e));
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [from, to]);
  return { years, error, loading };
}
