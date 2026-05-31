import { useCallback, useEffect, useState } from 'react';
import { getJson } from '@/lib/api';

export type TaxEntity = {
  id: number;
  kind: 'personal' | 'corp';
  legalName: string;
  jurisdiction: string;
  fiscalYearEnd: string | null;
  // Self-FK to another personal entity in the same household when linked as
  // spouses (P10). Backend `GET /api/tax/entities` echoes the column verbatim;
  // for non-personal kinds this stays null.
  spouseEntityId: number | null;
  // Free-form group tag (P11b T1) — corps sharing the same string are treated
  // as an associated group for SBD $500k + AAII $50k purposes. Engine ignores
  // it on personal entities; backend PATCH /api/tax/entities/:id rejects
  // setting it on non-corp.
  associatedGroupId: string | null;
  /** ISO 4217 currency derived from the entity's jurisdiction on the backend. */
  currency: string;
};

export function useTaxEntities() {
  const [entities, setEntities] = useState<TaxEntity[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // `reloadKey` bump triggers the fetch effect to re-run. Bumping it is the
  // public API for `reload()` — keeps the effect-as-source-of-truth pattern
  // intact instead of duplicating fetch logic inside a callback.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getJson<{ entities: TaxEntity[] }>('/api/tax/entities')
      .then((d) => { if (!cancelled) setEntities(d.entities); })
      .catch((e) => { if (!cancelled) setError(String(e?.message ?? e)); });
    return () => { cancelled = true; };
  }, [reloadKey]);

  const reload = useCallback(() => {
    setReloadKey((k) => k + 1);
  }, []);

  return { entities, error, reload };
}
