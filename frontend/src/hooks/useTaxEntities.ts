import { useEffect, useState } from 'react';
import { getJson } from '@/lib/api';

export type TaxEntity = {
  id: number;
  kind: 'personal' | 'corp';
  legalName: string;
  jurisdiction: string;
  fiscalYearEnd: string | null;
};

export function useTaxEntities() {
  const [entities, setEntities] = useState<TaxEntity[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    getJson<{ entities: TaxEntity[] }>('/api/tax/entities')
      .then((d) => { if (!cancelled) setEntities(d.entities); })
      .catch((e) => { if (!cancelled) setError(String(e?.message ?? e)); });
    return () => { cancelled = true; };
  }, []);
  return { entities, error };
}
