// Side-effect barrel that loads the projection modules so they register their
// projectors with projectionPorts. resolveScenario/resolveCorpScenario dispatch
// projection_root roots through those ports (to stay out of the resolve<->project
// import cycle), so a projection_root resolve throws unless the projector module
// has been loaded somewhere first.
//
// Importing this barrel from the scenario route entry points guarantees the
// projectors are registered before any request resolves a scenario. It is a
// registration-only, acyclic side-effect import: it depends on the project
// modules, which do not depend back on it.
import './projectPersonalFactsFromPrevYear';
import './projectCorpFactsFromPrevYear';
