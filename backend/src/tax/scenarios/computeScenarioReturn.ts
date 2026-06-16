// backend/src/tax/scenarios/computeScenarioReturn.ts
import crypto from 'node:crypto';
import { Scenario, ScenarioReturn } from '../../models';

export interface ComputeScenarioReturnOptions {
  /** If true, skip the cache check and always re-run the engine. */
  force?: boolean;
}

export interface ScenarioReturnResult {
  scenarioId: number;
  factsHash: string;
  computedAt: string;
  lines: unknown[];
  totals: Record<string, unknown>;
  warnings: string[];
  cached: boolean;
}

/** What an engine (buildT1 / buildT2) yields after computing a return. */
export interface EngineReturn {
  lines: unknown;
  totals: unknown;
  warnings: string[];
}

/**
 * Compute-and-cache core shared by the T1 (`computeScenario`) and T2
 * (`computeCorpScenario`) paths: resolve facts via `resolveFacts` → hash →
 * check the `ScenarioReturn` cache → run `runEngine` on a miss → persist (or
 * refresh in place on a forced recompute). The two callers differ only in how
 * facts are resolved and which engine runs, so those are injected.
 */
export async function computeScenarioReturn<F>(
  scenarioId: number,
  resolveFacts: (scenarioId: number) => Promise<F>,
  runEngine: (facts: F) => EngineReturn,
  options: ComputeScenarioReturnOptions = {},
): Promise<ScenarioReturnResult> {
  const scenario = await Scenario.findByPk(scenarioId);
  if (!scenario) throw new Error(`scenario id=${scenarioId} not found`);

  const facts = await resolveFacts(scenarioId);
  const factsHash = hashFacts(facts);

  if (!options.force) {
    const cached = await ScenarioReturn.findOne({
      where: { scenarioId, factsHash },
    });
    if (cached) {
      return {
        scenarioId,
        factsHash,
        computedAt: cached.computedAt.toISOString(),
        lines: cached.lines as unknown[],
        totals: cached.totals as Record<string, unknown>,
        warnings: cached.warnings as string[],
        cached: true,
      };
    }
  }

  const engineReturn = runEngine(facts);
  // Serialise Decimal → string so the cache row is JSON-safe round-trip.
  const lines = JSON.parse(JSON.stringify(engineReturn.lines));
  const totals = JSON.parse(JSON.stringify(engineReturn.totals));
  const warnings = engineReturn.warnings;
  const computedAt = new Date();

  // The (scenarioId, factsHash) unique index means a force recompute with
  // identical facts collides with the prior row. Refresh in place rather than
  // duplicating — semantically equivalent since the payload is deterministic.
  const existing = options.force
    ? await ScenarioReturn.findOne({ where: { scenarioId, factsHash } })
    : null;
  const row = existing
    ? await existing.update({ computedAt, lines, totals, warnings })
    : await ScenarioReturn.create({
        scenarioId,
        factsHash,
        computedAt,
        lines,
        totals,
        warnings,
      });

  return {
    scenarioId,
    factsHash,
    computedAt: row.computedAt.toISOString(),
    lines,
    totals,
    warnings,
    cached: false,
  };
}

/**
 * Build an uncached `ScenarioReturnResult` directly from an engine output and a
 * sentinel `factsHash`. Used by the HouseholdPlan path, where plan-scoped
 * facts intentionally bypass the `scenario_returns` cache — both the personal
 * and corp integrated paths synthesize the same result shape around their
 * engine output.
 */
export function synthesizeScenarioReturn(
  scenarioId: number,
  engineReturn: EngineReturn,
  factsHash: string,
): ScenarioReturnResult {
  return {
    scenarioId,
    factsHash,
    computedAt: new Date().toISOString(),
    lines: JSON.parse(JSON.stringify(engineReturn.lines)) as unknown[],
    totals: JSON.parse(JSON.stringify(engineReturn.totals)) as Record<string, unknown>,
    warnings: engineReturn.warnings,
    cached: false,
  };
}

/**
 * Canonical hash of a facts struct. Identical inputs always produce the same
 * hash. JSON.stringify with a replacer keeps Decimal values (which serialise as
 * objects) stable.
 */
function hashFacts(facts: unknown): string {
  const canonical = JSON.stringify(facts, replacer);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function replacer(_key: string, value: unknown): unknown {
  // Decimal instances expose toString() that gives stable representation
  if (value && typeof value === 'object' && 'toFixed' in (value as object)) {
    return (value as { toString: () => string }).toString();
  }
  return value;
}
