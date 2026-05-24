import { useEffect, useState } from 'react';

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
    fetch('/api/tax/entities', { credentials: 'include' })
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setEntities(d.entities); })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, []);
  return { entities, error };
}
