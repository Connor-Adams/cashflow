// Late-binding ports that break the resolve<->project scenario import cycle.
//
// The natural call graph is mutually recursive:
//   resolveScenario(id) -> projectPersonalFactsFromPrevYear(id)   (a projection_root resolves via projection)
//   projectPersonalFactsFromPrevYear(id) -> resolveScenario(parent)  (projection needs the parent's facts)
//                                        -> computeScenario(parent)   (projection needs the parent's return)
//
// `project*` keeps importing `resolve*`/`compute*` directly (it is the deeper
// module). `resolve*` must NOT import `project*` back, or the cycle returns, so
// it dispatches projection_root roots through these ports instead. Each
// `project*` module registers its projector at load time; loading any `project*`
// module pulls in `resolve*`/`compute*` via its own static imports, so importing
// `project*` wires everything. Registration is a load-time side effect; the port
// getters run only at call time, after module init has completed.
import type { TaxYearFacts, CorpTaxYearFacts } from '../engine/types';

type PersonalProjector = (scenarioId: number) => Promise<TaxYearFacts>;
type CorpProjector = (scenarioId: number) => Promise<CorpTaxYearFacts>;

let personalProjector: PersonalProjector | undefined;
let corpProjector: CorpProjector | undefined;

export function setPersonalProjector(fn: PersonalProjector): void {
  personalProjector = fn;
}
export function setCorpProjector(fn: CorpProjector): void {
  corpProjector = fn;
}

export function projectPersonalFactsViaPort(scenarioId: number): Promise<TaxYearFacts> {
  if (!personalProjector) {
    throw new Error(
      'projectionPorts: personal projector not registered (import projectPersonalFactsFromPrevYear before resolving a projection_root)',
    );
  }
  return personalProjector(scenarioId);
}
export function projectCorpFactsViaPort(scenarioId: number): Promise<CorpTaxYearFacts> {
  if (!corpProjector) {
    throw new Error(
      'projectionPorts: corp projector not registered (import projectCorpFactsFromPrevYear before resolving a projection_root)',
    );
  }
  return corpProjector(scenarioId);
}
