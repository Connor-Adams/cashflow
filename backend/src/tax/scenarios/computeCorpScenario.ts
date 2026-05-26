// backend/src/tax/scenarios/computeCorpScenario.ts
import crypto from 'node:crypto';
import { Scenario, ScenarioReturn } from '../../models';
import { resolveCorpScenario } from './resolveCorpScenario';
import { ratesFor } from '../engine/brackets';
import { buildT2 } from '../engine/t2';
import type { CorpTaxYearFacts } from '../engine/types';

export interface ComputeCorpScenarioOptions {
  /** If true, skip the cache check and always re-run the engine. */
  force?: boolean;
}

export interface ComputeCorpScenarioResult {
  scenarioId: number;
  factsHash: string;
  computedAt: string;
  lines: unknown[];
  totals: Record<string, unknown>;
  warnings: string[];
  cached: boolean;
}

/**
 * Compute a corp scenario's T2 return: resolve facts → hash → check cache →
 * run engine on miss → persist new cache row. Mirrors `computeScenario` (P7 T5)
 * but dispatches to `buildT2` against `CorpTaxYearFacts`.
 */
export async function computeCorpScenario(
  scenarioId: number,
  options: ComputeCorpScenarioOptions = {},
): Promise<ComputeCorpScenarioResult> {
  const scenario = await Scenario.findByPk(scenarioId);
  if (!scenario) throw new Error(`scenario id=${scenarioId} not found`);

  const facts = await resolveCorpScenario(scenarioId);
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

  const engineReturn = buildT2(facts, ratesFor(Number(facts.fiscalYear.startDate.slice(0, 4))));
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
 * Canonical hash of a corp facts struct. Identical inputs always produce the
 * same hash. JSON.stringify with a replacer keeps Decimal values (which
 * serialise as objects) stable.
 */
function hashFacts(facts: CorpTaxYearFacts): string {
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
