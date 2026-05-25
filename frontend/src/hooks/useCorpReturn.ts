import { useEffect, useState } from 'react';
import { getJson } from '@/lib/api';

export type CorpTaxLineDto = {
  code: string;
  label: string;
  amount: string; // serialized Decimal (toFixed(2))
  inputs: { source: string; amount: string }[];
  formula?: string;
};

export type CorpTaxReturnDto = {
  cached: boolean;
  computedAt: string;
  lines: CorpTaxLineDto[];
  totals: {
    activeBusinessIncome: string;
    sbdEligibleIncome: string;
    generalRateIncome: string;
    aii: string;
    taxableIncome: string;
    federalTax: string;
    provincialTax: string;
    refundableTaxOnAii: string;
    dividendRefund: string;
    netTaxPayable: string;
    gripEnding: string;
    cdaEnding: string;
    erdtohEnding: string;
    nerdtohEnding: string;
  };
  warnings: string[];
};

export function useCorpReturn(fiscalYear: string) {
  const [data, setData] = useState<CorpTaxReturnDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getJson<CorpTaxReturnDto>(`/api/tax/corp/${encodeURIComponent(fiscalYear)}/return`)
      .then((d) => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(String((e as Error)?.message ?? e));
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [fiscalYear]);

  return { data, error, loading };
}
