// frontend/src/hooks/useHouseholdPlans.ts
//
// HouseholdPlan CRUD hook (P8b Task 7). Mirrors the P7 `useScenarios` and
// P8a `useCorpScenarios` shape: list-on-mount with a `nonce` reload trigger,
// cancelled-flag pattern in the fetch effect, `useCallback`-memoized
// mutations that bump the nonce so the list re-fetches.
//
// Exposes 5 mutations:
//  - `create` POST /api/tax/household-plans         { name, notes? }   -> HouseholdPlan
//  - `patch`  PATCH /api/tax/household-plans/:id    { name?, notes? }  -> HouseholdPlan
//  - `addScenarios`     PATCH /:id { addScenarioIds }
//  - `removeScenarios`  PATCH /:id { removeScenarioIds }
//  - `remove` DELETE /api/tax/household-plans/:id
//
// Linkage mutations are thin PATCH wrappers (the backend exposes add/remove
// via PATCH body) so callers don't have to know the wire shape.
import { useCallback, useEffect, useState } from 'react';
import { deleteReq, getJson, patchJson, postJson } from '@/lib/api';

export interface HouseholdPlan {
  id: number;
  householdId: number;
  name: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateHouseholdPlanInput {
  name: string;
  notes?: string | null;
}

export type PatchHouseholdPlanInput = Partial<Pick<HouseholdPlan, 'name' | 'notes'>>;

interface UseHouseholdPlansResult {
  plans: HouseholdPlan[];
  loading: boolean;
  error: string | null;
  reload: () => void;
  create: (input: CreateHouseholdPlanInput) => Promise<HouseholdPlan>;
  patch: (id: number, body: PatchHouseholdPlanInput) => Promise<HouseholdPlan>;
  addScenarios: (id: number, scenarioIds: number[]) => Promise<HouseholdPlan>;
  removeScenarios: (id: number, scenarioIds: number[]) => Promise<HouseholdPlan>;
  remove: (id: number) => Promise<void>;
}

export function useHouseholdPlans(): UseHouseholdPlansResult {
  const [plans, setPlans] = useState<HouseholdPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getJson<{ plans: HouseholdPlan[] }>('/api/tax/household-plans')
      .then((d) => {
        if (!cancelled) {
          setPlans(d.plans);
          setLoading(false);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(String((e as Error)?.message ?? e));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const create = useCallback<UseHouseholdPlansResult['create']>(
    async (input) => {
      const body = await postJson<{ plan: HouseholdPlan }>(
        '/api/tax/household-plans',
        input,
      );
      reload();
      return body.plan;
    },
    [reload],
  );

  const patch = useCallback<UseHouseholdPlansResult['patch']>(
    async (id, body) => {
      const result = await patchJson<{ plan: HouseholdPlan }>(
        `/api/tax/household-plans/${id}`,
        body,
      );
      reload();
      return result.plan;
    },
    [reload],
  );

  const addScenarios = useCallback<UseHouseholdPlansResult['addScenarios']>(
    async (id, scenarioIds) => {
      const result = await patchJson<{ plan: HouseholdPlan }>(
        `/api/tax/household-plans/${id}`,
        { addScenarioIds: scenarioIds },
      );
      reload();
      return result.plan;
    },
    [reload],
  );

  const removeScenarios = useCallback<UseHouseholdPlansResult['removeScenarios']>(
    async (id, scenarioIds) => {
      const result = await patchJson<{ plan: HouseholdPlan }>(
        `/api/tax/household-plans/${id}`,
        { removeScenarioIds: scenarioIds },
      );
      reload();
      return result.plan;
    },
    [reload],
  );

  const remove = useCallback<UseHouseholdPlansResult['remove']>(
    async (id) => {
      await deleteReq(`/api/tax/household-plans/${id}`);
      reload();
    },
    [reload],
  );

  return {
    plans,
    loading,
    error,
    reload,
    create,
    patch,
    addScenarios,
    removeScenarios,
    remove,
  };
}
