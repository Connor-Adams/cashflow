import { useCallback, useEffect, useState } from 'react';
import { getJson } from '@/lib/api';
import type { TaxTreatment } from '../lib/taxTreatment';

export interface QueueLeg {
  id: number;
  date: string;
  amount: string;
  currency: string;
  merchantClean: string | null;
  accountId: number;
  accountName: string | null;
  txnType: string;
  taxTreatmentOverride: TaxTreatment | null;
}

export interface ClassificationQueue {
  corpDistributions: { personal: QueueLeg; corp: QueueLeg }[];
  payroll: QueueLeg[];
}

interface UseClassificationQueueResult {
  data: ClassificationQueue | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

export function useClassificationQueue(
  entityId: number | null,
  year: number,
  status: 'unclassified' | 'classified' = 'unclassified',
): UseClassificationQueueResult {
  const [data, setData] = useState<ClassificationQueue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (entityId == null) {
      setData(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    getJson<ClassificationQueue>(
      `/api/tax/classification-queue?entityId=${entityId}&year=${year}&status=${status}`,
    )
      .then((d) => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(String((e as Error)?.message ?? e));
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [entityId, year, status, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { data, error, loading, reload };
}
