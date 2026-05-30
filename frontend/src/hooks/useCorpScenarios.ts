import { useCallback, useEffect, useState } from 'react';
import { deleteReq, getJson, patchJson, postJson } from '@/lib/api';

export type CorpScenarioKind = 'baseline' | 'fork' | 'projection_root';

export interface CorpScenario {
  id: number;
  parentId: number | null;
  entityId: number;
  year: number;
  name: string;
  kind: CorpScenarioKind;
  overrides: Record<string, unknown>;
  assumptions: Record<string, unknown>;
  nextYearId: number | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CorpComputedReturn {
  scenarioId: number;
  factsHash: string;
  computedAt: string;
  lines: unknown[];
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
    [key: string]: string | number;
  };
  warnings: string[];
  cached: boolean;
}

export interface CorpScenarioWithComputed {
  scenario: CorpScenario;
  computed: CorpComputedReturn;
}

export interface CreateCorpScenarioInput {
  name: string;
  overrides?: Record<string, unknown>;
  assumptions?: Record<string, unknown>;
  parentId?: number | null;
  notes?: string | null;
}

export type PatchCorpScenarioInput = Partial<
  Pick<CorpScenario, 'name' | 'notes' | 'overrides' | 'assumptions'>
>;

export interface ProjectNextCorpYearInput {
  name?: string;
  assumptions?: Record<string, unknown>;
}

interface UseCorpScenariosResult {
  scenarios: CorpScenario[];
  loading: boolean;
  error: string | null;
  reload: () => void;
  create: (input: CreateCorpScenarioInput) => Promise<CorpScenario>;
  patch: (id: number, body: PatchCorpScenarioInput) => Promise<CorpScenario>;
  fork: (id: number, name?: string) => Promise<CorpScenario>;
  remove: (id: number) => Promise<void>;
  projectNextYear: (id: number, input?: ProjectNextCorpYearInput) => Promise<CorpScenario>;
}

export function useCorpScenarios(entityId: number, year: number): UseCorpScenariosResult {
  const [scenarios, setScenarios] = useState<CorpScenario[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getJson<{ scenarios: CorpScenario[] }>(
      `/api/tax/scenarios/corp?entityId=${entityId}&year=${year}`,
    )
      .then((d) => { if (!cancelled) { setScenarios(d.scenarios); setLoading(false); } })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(String((e as Error)?.message ?? e));
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [entityId, year, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const create = useCallback<UseCorpScenariosResult['create']>(
    async (input) => {
      const body = await postJson<{ scenario: CorpScenario }>(
        '/api/tax/scenarios/corp',
        { entityId, year, ...input },
      );
      reload();
      return body.scenario;
    },
    [entityId, year, reload],
  );

  const patch = useCallback<UseCorpScenariosResult['patch']>(
    async (id, body) => {
      const result = await patchJson<{ scenario: CorpScenario }>(
        `/api/tax/scenarios/corp/${id}`,
        body,
      );
      reload();
      return result.scenario;
    },
    [reload],
  );

  const fork = useCallback<UseCorpScenariosResult['fork']>(
    async (id, name) => {
      const body = await postJson<{ scenario: CorpScenario }>(
        `/api/tax/scenarios/corp/${id}/fork`,
        name ? { name } : {},
      );
      reload();
      return body.scenario;
    },
    [reload],
  );

  const remove = useCallback<UseCorpScenariosResult['remove']>(
    async (id) => {
      await deleteReq(`/api/tax/scenarios/corp/${id}`);
      reload();
    },
    [reload],
  );

  // Mirrors `fork`: POSTs to `/:id/project-next-year`, reloads the scenarios
  // list (the freshly-created projection_root lives in year+1 — the caller is
  // responsible for re-keying any year-scoped hooks to surface it), and returns
  // the new scenario so the caller can select it.
  const projectNextYear = useCallback<UseCorpScenariosResult['projectNextYear']>(
    async (id, input) => {
      const body = await postJson<{ scenario: CorpScenario }>(
        `/api/tax/scenarios/corp/${id}/project-next-year`,
        input ?? {},
      );
      reload();
      return body.scenario;
    },
    [reload],
  );

  return {
    scenarios,
    loading,
    error,
    reload,
    create,
    patch,
    fork,
    remove,
    projectNextYear,
  };
}
