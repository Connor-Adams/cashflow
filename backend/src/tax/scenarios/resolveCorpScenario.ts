// backend/src/tax/scenarios/resolveCorpScenario.ts
import { Entity, Scenario } from '../../models';
import { buildCorpFacts } from '../builders/buildCorpFacts';
import { applyOverrides } from './applyOverrides';
import { projectCorpFactsFromPrevYear } from './projectCorpFactsFromPrevYear';
import type { OverrideMap } from './types';
import type { CorpTaxYearFacts } from '../engine/types';

const MAX_ANCESTRY_DEPTH = 16;

/**
 * Find or create the baseline scenario for a corp (entityId, year). Baselines
 * are system-generated, always named "Baseline", parentId=null, no overrides.
 */
export async function ensureCorpBaselineScenario(
  entityId: number,
  year: number,
): Promise<Scenario> {
  const existing = await Scenario.findOne({
    where: { entityId, year, kind: 'baseline' },
  });
  if (existing) return existing;
  return Scenario.create({
    parentId: null,
    householdPlanId: null,
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
 * Resolve a corp scenario into final `CorpTaxYearFacts` by walking the parent
 * chain from root to leaf, layering each node's override map onto the actuals.
 *
 * Throws if the ancestry exceeds `MAX_ANCESTRY_DEPTH` (cycle detection), if the
 * scenario references an entity that is not `kind: 'corp'`, or if any scenario
 * in the chain references an unknown override key.
 *
 * P8a note: calendar-year fiscal years only. The corp's `fiscalYearEnd` field
 * isn't consulted yet — P8b will adapt for non-calendar fiscal years.
 */
export async function resolveCorpScenario(scenarioId: number): Promise<CorpTaxYearFacts> {
  const ancestry = await loadAncestry(scenarioId);
  const root = ancestry[0];
  const entity = await Entity.findByPk(root.entityId);
  if (!entity) throw new Error(`entity id=${root.entityId} not found`);
  if (entity.kind !== 'corp') {
    throw new Error(`scenario id=${scenarioId} references entity kind=${entity.kind}, not corp`);
  }
  const baseFacts = root.kind === 'projection_root'
    ? await projectCorpFactsFromPrevYear(root.id)
    : await buildCorpFacts(root.entityId, {
      startDate: `${root.year}-01-01`,
      endDate: `${root.year}-12-31`,
    });
  const overrideChain: OverrideMap[] = ancestry.map((s) => s.overrides as OverrideMap);
  return applyOverrides(baseFacts, overrideChain, 'corp');
}

/**
 * Walk parentId chain from given scenario back to root. Returns root-first array.
 *
 * A `projection_root` scenario terminates the walk: it acts as a year boundary
 * (its parent lives in a different year so overrides above it must not layer
 * onto the projected facts).
 */
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
    if (node.kind === 'projection_root') break;
    currentId = node.parentId;
  }
  return reverse.reverse(); // root-first
}
