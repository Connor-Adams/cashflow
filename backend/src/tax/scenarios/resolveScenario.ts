// backend/src/tax/scenarios/resolveScenario.ts
import { buildPersonalFacts } from '../builders/buildPersonalFacts';
import { applyOverrides } from './applyOverrides';
// projectPersonalFactsFromPrevYear is reached through a port (not imported
// directly) to break the resolve<->project import cycle: projectPersonal imports
// resolveScenario, so resolveScenario must not import projectPersonal back. The
// projector registers itself with the port at module load. See projectionPorts.ts.
import { projectPersonalFactsViaPort } from './projectionPorts';
import { ensureBaselineScenario, loadScenarioAncestry } from './scenarioAncestry';
import type { OverrideMap } from './types';
import type { TaxYearFacts } from '../engine/types';

// Re-exported so existing importers (routes, tests) keep their import path.
export { ensureBaselineScenario };

/**
 * Resolve a scenario into final `TaxYearFacts` by walking the parent chain
 * from root to leaf, layering each node's override map onto the actuals.
 *
 * Throws if the ancestry exceeds the max depth (cycle detection) or if any
 * scenario in the chain references an unknown override key.
 */
export async function resolveScenario(scenarioId: number): Promise<TaxYearFacts> {
  const ancestry = await loadScenarioAncestry(scenarioId);
  const root = ancestry[0];
  const baseFacts = root.kind === 'projection_root'
    ? await projectPersonalFactsViaPort(root.id)
    : await buildPersonalFacts(root.entityId, root.year);
  const overrideChain: OverrideMap[] = ancestry.map((s) => s.overrides as OverrideMap);
  return applyOverrides(baseFacts, overrideChain, 'personal');
}
