// backend/src/tax/scenarios/resolveCorpScenario.ts
import { Entity } from '../../models';
import { buildCorpFacts } from '../builders/buildCorpFacts';
import { applyOverrides } from './applyOverrides';
import { projectCorpFactsFromPrevYear } from './projectCorpFactsFromPrevYear';
import { ensureBaselineScenario, loadScenarioAncestry } from './scenarioAncestry';
import type { OverrideMap } from './types';
import type { CorpTaxYearFacts } from '../engine/types';

/**
 * Find or create the baseline scenario for a corp (entityId, year). Baselines
 * use the same row shape for every entity kind, so this is the shared
 * `ensureBaselineScenario` re-exported under the corp-flavoured name existing
 * importers (routes, tests) already use.
 */
export const ensureCorpBaselineScenario = ensureBaselineScenario;

/**
 * Resolve a corp scenario into final `CorpTaxYearFacts` by walking the parent
 * chain from root to leaf, layering each node's override map onto the actuals.
 *
 * Throws if the ancestry exceeds the max depth (cycle detection), if the
 * scenario references an entity that is not `kind: 'corp'`, or if any scenario
 * in the chain references an unknown override key.
 *
 * P8a note: calendar-year fiscal years only. The corp's `fiscalYearEnd` field
 * isn't consulted yet — P8b will adapt for non-calendar fiscal years.
 */
export async function resolveCorpScenario(scenarioId: number): Promise<CorpTaxYearFacts> {
  const ancestry = await loadScenarioAncestry(scenarioId);
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
