import { useEffect, useState } from 'react';
import { getJson } from '@/lib/api';

export type ReconciliationSeverity = 'info' | 'warning' | 'error';

export type ReconciliationCategory =
  | 'missing_slip'
  | 'slip_divergence'
  | 'category_misclass';

export interface ReconciliationFinding {
  category: ReconciliationCategory;
  severity: ReconciliationSeverity;
  subjectRef: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ReconciliationReport {
  entityId: number;
  year: number;
  generatedAt: string;
  findings: ReconciliationFinding[];
  counts: Record<ReconciliationCategory, number>;
}

interface UseReconciliationResult {
  data: ReconciliationReport | null;
  error: string | null;
  loading: boolean;
}

export function useReconciliation(year: number): UseReconciliationResult {
  const [data, setData] = useState<ReconciliationReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getJson<ReconciliationReport>(`/api/tax/personal/${year}/reconciliation`)
      .then((d) => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(String((e as Error)?.message ?? e));
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [year]);

  return { data, error, loading };
}
