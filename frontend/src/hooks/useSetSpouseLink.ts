// frontend/src/hooks/useSetSpouseLink.ts
//
// P10 Task 6: thin mutation hook that wraps the spouse-link API endpoints
// shipped in P10 T2 (commit 5d1bb3d). The endpoints set/clear the reciprocal
// `spouseEntityId` self-FK on `tax_entities` atomically inside a transaction;
// this hook is just an ergonomic frontend wrapper.
//
//   POST   /api/tax/entities/:id/spouse  body { spouseEntityId } → 200 { entity }
//   DELETE /api/tax/entities/:id/spouse                          → 204
//
// Surface: `{ setSpouse, unsetSpouse, loading, error }`. The caller is expected
// to trigger its own reload (e.g. via `onChange()` on the picker) — the hook
// does not own state for the entity itself, just the in-flight request flags.
import { useCallback, useState } from 'react';
import { deleteReq, postJson } from '@/lib/api';

interface UseSetSpouseLinkResult {
  setSpouse: (spouseEntityId: number) => Promise<void>;
  unsetSpouse: () => Promise<void>;
  loading: boolean;
  error: string | null;
}

export function useSetSpouseLink(entityId: number): UseSetSpouseLinkResult {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setSpouse = useCallback<UseSetSpouseLinkResult['setSpouse']>(
    async (spouseEntityId) => {
      setLoading(true);
      setError(null);
      try {
        await postJson(`/api/tax/entities/${entityId}/spouse`, { spouseEntityId });
      } catch (e: unknown) {
        const msg = String((e as Error)?.message ?? e);
        setError(msg);
        throw e;
      } finally {
        setLoading(false);
      }
    },
    [entityId],
  );

  const unsetSpouse = useCallback<UseSetSpouseLinkResult['unsetSpouse']>(
    async () => {
      setLoading(true);
      setError(null);
      try {
        await deleteReq(`/api/tax/entities/${entityId}/spouse`);
      } catch (e: unknown) {
        const msg = String((e as Error)?.message ?? e);
        setError(msg);
        throw e;
      } finally {
        setLoading(false);
      }
    },
    [entityId],
  );

  return { setSpouse, unsetSpouse, loading, error };
}
