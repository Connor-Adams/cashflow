import { useCallback, useState } from 'react';
import { postJson } from '@/lib/api';

export type ScenarioOwnerComp = {
  salary: string;
  eligibleDividends: string;
  nonEligibleDividends: string;
};

export type ScenarioResultDto = {
  combinedTotals: {
    corpNetTaxPayable: string;
    personalTotalPayable: string;
    personalAfterTaxIncome: string;
    householdTotalTax: string;
    effectiveRate: string;
  };
  // Full corp/personal returns are also in the response but we only surface combinedTotals
};

export type RunScenarioInput = {
  year: number;
  ownerComp: {
    salary: number;
    eligibleDividends: number;
    nonEligibleDividends: number;
  };
};

export function useScenario() {
  const [result, setResult] = useState<ScenarioResultDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const run = useCallback(async (input: RunScenarioInput) => {
    setLoading(true);
    setError(null);
    try {
      const d = await postJson<ScenarioResultDto>('/api/tax/scenarios', input);
      setResult(d);
    } catch (e: unknown) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, []);

  return { result, error, loading, run };
}
