/**
 * What the number on the Personal T1 tab actually is.
 *
 * A scenario's `kind` decides which question its total answers, and the tab used
 * to auto-select the most-recently-created non-baseline scenario. In prod that was
 * a `projection_root`, which `resolveScenario` routes through
 * `projectPersonalFactsFromPrevYear` — the prior year scaled by inflation, with no
 * transactions from the year on screen at all. Rendered without a label it read as
 * the year's return.
 *
 * Both functions here are pure so the rule can be tested without mounting the tab.
 */
import type { Scenario } from '../../../hooks/useScenarios';

/**
 * The scenario to show when the user has not chosen one.
 *
 * The baseline, whenever there is one: it is the only kind that resolves to the
 * year's actuals. Falls back to the first scenario so a tree with no baseline
 * still renders something, and null for an empty tree.
 */
export function pickDefaultScenarioId(scenarios: Scenario[]): number | null {
  if (scenarios.length === 0) return null;
  const baseline = scenarios.find((s) => s.kind === 'baseline');
  return (baseline ?? scenarios[0]).id;
}

export interface Provenance {
  /** Short badge: what this number is. */
  label: string;
  /** What it does not contain, when that needs saying. */
  caveat: string | null;
  /** True when the total answers a different year's question. */
  isProjection: boolean;
}

export function describeProvenance(scenario: Scenario): Provenance {
  switch (scenario.kind) {
    case 'baseline':
      return { label: 'Actuals', caveat: null, isProjection: false };
    case 'projection_root':
      return {
        label: `Projection from ${scenario.year - 1}`,
        caveat: `Contains no transactions from ${scenario.year}.`,
        isProjection: true,
      };
    default:
      return { label: 'Actuals + overrides', caveat: null, isProjection: false };
  }
}
