// backend/src/tax/scenarios/scenarioAncestry.ts
import { Scenario } from '../../models';

export const MAX_ANCESTRY_DEPTH = 16;

/**
 * Find or create the baseline scenario for (entityId, year). Baselines are
 * system-generated, always named "Baseline", parentId=null, no overrides.
 *
 * Shared by the personal and corp resolvers — the row shape and idempotency
 * check are identical for both entity kinds.
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
 * Walk the parentId chain from the given scenario back to its root. Returns a
 * root-first array.
 *
 * A `projection_root` scenario terminates the walk: it acts as a year boundary
 * (its parent lives in a different year so overrides above it must not layer
 * onto the projected facts). Throws on cycles or when the chain exceeds
 * `MAX_ANCESTRY_DEPTH`.
 */
export async function loadScenarioAncestry(leafId: number): Promise<Scenario[]> {
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
