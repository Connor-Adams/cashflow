// backend/src/tax/scenarios/resolveScenario.ts
import { Scenario } from '../../models';
import { buildPersonalFacts } from '../builders/buildPersonalFacts';
import { applyOverrides } from './applyOverrides';
import type { OverrideMap } from './types';
import type { TaxYearFacts } from '../engine/types';

const MAX_ANCESTRY_DEPTH = 16;

/**
 * Find or create the baseline scenario for (entityId, year). Baselines are
 * system-generated, always named "Baseline", parentId=null, no overrides.
 */
export async function ensureBaselineScenario(
  entityId: number,
  year: number,
): Promise<Scenario> {
  const existing = await Scenario.findOne({
    where: { entityId, year, kind: 'baseline' },
  });
  if (existing) return existing;
  return Scenario.create({
    parentId: null,
    entityId,
    year,
    name: 'Baseline',
    kind: 'baseline',
    overrides: {},
    assumptions: {},
    nextYearId: null,
    notes: null,
  });
}

/**
 * Resolve a scenario into final `TaxYearFacts` by walking the parent chain
 * from root to leaf, layering each node's override map onto the actuals.
 *
 * Throws if the ancestry exceeds `MAX_ANCESTRY_DEPTH` (cycle detection) or
 * if any scenario in the chain references an unknown override key.
 */
export async function resolveScenario(scenarioId: number): Promise<TaxYearFacts> {
  const ancestry = await loadAncestry(scenarioId);
  const root = ancestry[0];
  const baseFacts = await buildPersonalFacts(root.entityId, root.year);
  const overrideChain: OverrideMap[] = ancestry.map((s) => s.overrides as OverrideMap);
  return applyOverrides(baseFacts, overrideChain, 'personal');
}

/** Walk parentId chain from given scenario back to root. Returns root-first array. */
async function loadAncestry(leafId: number): Promise<Scenario[]> {
  const reverse: Scenario[] = [];
  const seen = new Set<number>();
  let currentId: number | null = leafId;
  while (currentId !== null) {
    if (seen.has(currentId)) {
      throw new Error(`scenario ancestry cycle detected at id=${currentId}`);
    }
    seen.add(currentId);
    if (reverse.length >= MAX_ANCESTRY_DEPTH) {
      throw new Error(`scenario ancestry exceeds max depth ${MAX_ANCESTRY_DEPTH}`);
    }
    const node: Scenario | null = await Scenario.findByPk(currentId);
    if (!node) throw new Error(`scenario id=${currentId} not found while walking ancestry`);
    reverse.push(node);
    currentId = node.parentId;
  }
  return reverse.reverse(); // root-first
}
