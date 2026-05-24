import { useEffect, useState } from 'react';
import { getJson } from '@/lib/api';

export type TaxLineDto = {
  code: string;
  label: string;
  amount: string; // serialized Decimal (toFixed(2))
  inputs: { source: string; amount: string }[];
  formula?: string;
};

export type TaxReturnDto = {
  cached: boolean;
  computedAt: string;
  lines: TaxLineDto[];
  totals: Record<string, string>;
  warnings: string[];
};

export function useTaxReturn(year: number) {
  const [data, setData] = useState<TaxReturnDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getJson<TaxReturnDto>(`/api/tax/personal/${year}/return`)
      .then((d) => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch((e) => { if (!cancelled) { setError(String(e?.message ?? e)); setLoading(false); } });
    return () => { cancelled = true; };
  }, [year]);
  return { data, error, loading };
}
