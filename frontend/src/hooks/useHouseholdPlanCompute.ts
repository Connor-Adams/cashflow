// frontend/src/hooks/useHouseholdPlanCompute.ts
//
// HouseholdPlan integrated compute hook (P8b Task 7). Fetches
// `GET /api/tax/household-plans/:id/compute` which runs the orchestrator:
// compute corp scenarios -> integration router -> compute personal scenarios
// with routed additions injected.
//
// Returns `{ data, loading, error, reload }` with the cancelled-flag pattern
// from `useScenarioDetail` / `useCorpScenarioDetail`. When `planId` is null
// (e.g. "no plan selected" picker state), the hook clears state and returns
// nulls without making a network request.
//
// Decimal-valued fields (employmentIncome, gripEnding, etc.) cross the wire
// as strings — preserved verbatim here. Render-time formatting + arithmetic
// should re-hydrate with the shared D() helper.
import { useCallback, useEffect, useState } from 'react';
import { getJson } from '@/lib/api';
import type { CorpComputedReturn, CorpScenario } from './useCorpScenarios';
import type { ComputedReturn, Scenario } from './useScenarios';

export interface PersonalAdditions {
  employmentIncome: string;
  eligibleDividends: string;
  nonEligibleDividends: string;
  capitalDividendsReceived: string;
  cppEnrolled: boolean;
}

export interface IntegrationWarning {
  severity: 'warning' | 'error';
  shareholderEntityId: number | null;
  corpScenarioId: number | null;
  message: string;
}

export interface IntegrationResult {
  byShareholder: Record<string, PersonalAdditions>;
  warnings: IntegrationWarning[];
}

export interface CorpScenarioComputeEntry {
  scenario: CorpScenario;
  computed: CorpComputedReturn;
}

export interface PersonalScenarioComputeEntry {
  scenario: Scenario;
  computed: ComputedReturn;
}

export interface HouseholdPlanComputeResult {
  planId: number;
  corp: CorpScenarioComputeEntry[];
  personal: PersonalScenarioComputeEntry[];
  integration: IntegrationResult;
}

interface UseHouseholdPlanComputeResult {
  data: HouseholdPlanComputeResult | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useHouseholdPlanCompute(
  planId: number | null,
): UseHouseholdPlanComputeResult {
  const [data, setData] = useState<HouseholdPlanComputeResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (planId === null) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    getJson<HouseholdPlanComputeResult>(`/api/tax/household-plans/${planId}/compute`)
      .then((d) => {
        if (!cancelled) {
          setData(d);
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
  }, [planId, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { data, loading, error, reload };
}
