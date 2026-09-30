// backend/src/tax/scenarios/computeCorpScenario.ts
import { resolveCorpScenario } from './resolveCorpScenario';
import { ratesFor } from '../engine/brackets';
import { buildT2 } from '../engine/t2';
import type { CorpTaxYearFacts } from '../engine/types';
import {
  computeScenarioReturn,
  type ComputeScenarioReturnOptions,
  type ScenarioComputation,
} from './computeScenarioReturn';

export type ComputeCorpScenarioOptions = ComputeScenarioReturnOptions;
/** Result plus the facts it ran on, mirroring the personal path. */
export type ComputeCorpScenarioResult = ScenarioComputation<CorpTaxYearFacts>;

/**
 * Compute a corp scenario's T2 return: resolve facts → hash → check cache → run
 * the T2 engine on a miss → persist. Mirrors `computeScenario` (P7 T5) but
 * dispatches to `buildT2` against `CorpTaxYearFacts`; both share the cache
 * machinery in `computeScenarioReturn`.
 */
export async function computeCorpScenario(
  scenarioId: number,
  options: ComputeCorpScenarioOptions = {},
): Promise<ComputeCorpScenarioResult> {
  return computeScenarioReturn(
    scenarioId,
    resolveCorpScenario,
    (facts) => buildT2(facts, ratesFor(Number(facts.fiscalYear.startDate.slice(0, 4)))),
    options,
  );
}
