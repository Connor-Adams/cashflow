import { useCallback, useEffect, useState } from 'react';
import { deleteReq, getJson, patchJson, postJson } from '@/lib/api';

export type ScenarioKind = 'baseline' | 'fork' | 'projection_root';

export interface Scenario {
  id: number;
  parentId: number | null;
  entityId: number;
  year: number;
  name: string;
  kind: ScenarioKind;
  overrides: Record<string, unknown>;
  assumptions: Record<string, unknown>;
  nextYearId: number | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ComputedReturn {
  scenarioId: number;
  factsHash: string;
  computedAt: string;
  lines: unknown[];
  totals: Record<string, string | number>;
  warnings: string[];
  cached: boolean;
}

export interface ScenarioWithComputed {
  scenario: Scenario;
  computed: ComputedReturn;
}

export interface CreateScenarioInput {
  name: string;
  overrides?: Record<string, unknown>;
  assumptions?: Record<string, unknown>;
  parentId?: number | null;
  notes?: string | null;
}

export type PatchScenarioInput = Partial<
  Pick<Scenario, 'name' | 'notes' | 'overrides' | 'assumptions'>
>;

export interface ProjectNextYearInput {
  name?: string;
  assumptions?: Record<string, unknown>;
}

interface UseScenariosResult {
  scenarios: Scenario[];
  loading: boolean;
  error: string | null;
  reload: () => void;
  create: (input: CreateScenarioInput) => Promise<Scenario>;
  patch: (id: number, body: PatchScenarioInput) => Promise<Scenario>;
  fork: (id: number, name?: string) => Promise<Scenario>;
  remove: (id: number) => Promise<void>;
  projectNextYear: (id: number, input?: ProjectNextYearInput) => Promise<Scenario>;
}

export function useScenarios(entityId: number, year: number): UseScenariosResult {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getJson<{ scenarios: Scenario[] }>(
      `/api/tax/scenarios/personal?entityId=${entityId}&year=${year}`,
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

  const create = useCallback<UseScenariosResult['create']>(
    async (input) => {
      const body = await postJson<{ scenario: Scenario }>(
        '/api/tax/scenarios/personal',
        { entityId, year, ...input },
      );
      reload();
      return body.scenario;
    },
    [entityId, year, reload],
  );

  const patch = useCallback<UseScenariosResult['patch']>(
    async (id, body) => {
      const result = await patchJson<{ scenario: Scenario }>(
        `/api/tax/scenarios/personal/${id}`,
        body,
      );
      reload();
      return result.scenario;
    },
    [reload],
  );

  const fork = useCallback<UseScenariosResult['fork']>(
    async (id, name) => {
      const body = await postJson<{ scenario: Scenario }>(
        `/api/tax/scenarios/personal/${id}/fork`,
        name ? { name } : {},
      );
      reload();
      return body.scenario;
    },
    [reload],
  );

  const remove = useCallback<UseScenariosResult['remove']>(
    async (id) => {
      await deleteReq(`/api/tax/scenarios/personal/${id}`);
      reload();
    },
    [reload],
  );

  // Mirrors `fork`: POSTs to `/:id/project-next-year`, reloads the scenarios
  // list (the freshly-created projection_root lives in year+1 — the caller is
  // responsible for re-keying any year-scoped hooks to surface it), and returns
  // the new scenario so the caller can select it.
  const projectNextYear = useCallback<UseScenariosResult['projectNextYear']>(
    async (id, input) => {
      const body = await postJson<{ scenario: Scenario }>(
        `/api/tax/scenarios/personal/${id}/project-next-year`,
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

interface UseScenarioDetailResult {
  data: ScenarioWithComputed | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useScenarioDetail(id: number | null): UseScenarioDetailResult {
  const [data, setData] = useState<ScenarioWithComputed | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (id === null) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    getJson<ScenarioWithComputed>(`/api/tax/scenarios/personal/${id}`)
      .then((d) => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(String((e as Error)?.message ?? e));
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [id, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { data, loading, error, reload };
}
