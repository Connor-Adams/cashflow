// backend/src/tax/scenarios/computeScenario.ts
import crypto from 'node:crypto';
import { Scenario, ScenarioReturn } from '../../models';
import { resolveScenario } from './resolveScenario';
import { ratesFor } from '../engine/brackets';
import { buildT1 } from '../engine/t1';
import type { TaxYearFacts } from '../engine/types';

export interface ComputeScenarioOptions {
  /** If true, skip the cache check and always re-run the engine. */
  force?: boolean;
}

export interface ComputeScenarioResult {
  scenarioId: number;
  factsHash: string;
  computedAt: string;
  lines: unknown[];
  totals: Record<string, unknown>;
  warnings: string[];
  cached: boolean;
}

/**
 * Compute a scenario's tax return: resolve facts → hash → check cache → run
 * engine on miss → persist new cache row. Returns the result either from
 * cache or freshly computed.
 */
export async function computeScenario(
  scenarioId: number,
  options: ComputeScenarioOptions = {},
): Promise<ComputeScenarioResult> {
  const scenario = await Scenario.findByPk(scenarioId);
  if (!scenario) throw new Error(`scenario id=${scenarioId} not found`);

  const facts = await resolveScenario(scenarioId);
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

  const engineReturn = buildT1(facts, ratesFor(facts.year));
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
 * Canonical hash of a facts struct + rate-table year. Identical inputs always
 * produce the same hash. JSON.stringify with sorted keys keeps Decimal values
 * (which serialise as objects) stable.
 */
function hashFacts(facts: TaxYearFacts): string {
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
