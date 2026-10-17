// backend/src/tax/scenarios/computeScenario.ts
import { resolveScenario } from './resolveScenario';
import { ratesFor } from '../engine/brackets';
import { buildT1 } from '../engine/t1';
import type { TaxYearFacts } from '../engine/types';
import {
  computeScenarioReturn,
  type ComputeScenarioReturnOptions,
  type ScenarioComputation,
} from './computeScenarioReturn';

export type ComputeScenarioOptions = ComputeScenarioReturnOptions;
/** Result plus the facts it ran on — the completeness gate needs the latter. */
export type ComputeScenarioResult = ScenarioComputation<TaxYearFacts>;

/**
 * Compute a scenario's T1 return: resolve facts → hash → check cache → run the
 * T1 engine on a miss → persist. Delegates the cache machinery to
 * `computeScenarioReturn`, supplying the personal facts resolver + T1 engine.
 */
export async function computeScenario(
  scenarioId: number,
  options: ComputeScenarioOptions = {},
): Promise<ComputeScenarioResult> {
  return computeScenarioReturn(
    scenarioId,
    resolveScenario,
    (facts) => buildT1(facts, ratesFor(facts.year)),
    options,
  );
}
