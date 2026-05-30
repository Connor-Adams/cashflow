/**
 * Pure scenario runner for issue #213 (financial scenario planner).
 *
 * Takes a baseline forecast result + a list of hypothetical assumption
 * overrides and produces a second forecast, then diffs the two.
 *
 * Assumptions can be:
 *   - income      : recurring or one-off cash inflow
 *   - expense     : recurring or one-off cash outflow
 *   - savings     : earmarked outflow (maps to 'out' direction in forecast)
 *   - one_off     : a single one-time event (direction specified explicitly)
 *
 * NOTE: 'debt_payoff' assumption type is intentionally omitted in this version
 * — it depends on the debt planner (issue #202) which is still open. When
 * #202 ships, add a 'debt_payoff' type here that maps to a sequence of
 * 'out' occurrences. See GitHub issue #213 for the cross-reference.
 *
 * The function is pure (no DB). The route calls buildForecast() twice:
 * once for the baseline (no overrides) and once injecting the assumption
 * occurrences alongside the real planned-events.
 */

import {
  buildForecast,
  type BuildForecastInput,
  type BuildForecastResult,
  type ForecastOccurrence,
} from '../forecast/buildForecast';
import { expandRecurrence } from '../forecast/expandRecurrence';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AssumptionType = 'income' | 'expense' | 'savings' | 'one_off';

export type AssumptionRecurrence = 'weekly' | 'biweekly' | 'monthly';

/**
 * A single hypothetical override to inject into the scenario forecast.
 *
 * For recurring assumptions, `recurrence` must be set and `startDate` acts
 * as the seed date (same as PlannedEvent.expectedDate).  `endDate` is the
 * last date at which an occurrence is allowed (inclusive).  Omitting
 * `endDate` means the recurrence runs to the end of the forecast window.
 *
 * For one-off events (`type === 'one_off'` or `recurrence` omitted),
 * `startDate` is the single event date.
 *
 * `direction` is only used when `type === 'one_off'`; for the structured
 * types (`income`, `expense`, `savings`) direction is inferred from type.
 */
export type ScenarioAssumption = {
  /** Display label for the assumption row in the UI. */
  label: string;
  type: AssumptionType;
  /** Absolute amount in the scenario currency, always non-negative. */
  amount: number;
  /** Seed/start date (YYYY-MM-DD). */
  startDate: string;
  /** Optional end date for recurring assumptions (YYYY-MM-DD). */
  endDate?: string | null;
  /** Optional recurrence cadence. Omit for one-off events. */
  recurrence?: AssumptionRecurrence | null;
  /**
   * Only consulted when type === 'one_off'. Defaults to 'out' if omitted.
   * For structured types the direction is always inferred:
   *   income  → 'in'
   *   expense → 'out'
   *   savings → 'out'
   */
  direction?: 'in' | 'out' | null;
};

export type AssumptionsJson = {
  /** Human-readable name displayed in the UI heading. */
  name: string;
  /**
   * How many days to use for the forecast window when computing this
   * scenario. Defaults to 30.  Only 30 | 60 | 90 are currently valid.
   */
  baselineDays?: 30 | 60 | 90;
  overrides: ScenarioAssumption[];
};

export type ScenarioForecastSummary = {
  /** Projected closing balance at the end of the window. */
  closing: number;
  /** Lowest projected balance across the window. */
  lowest: number;
  /** Date (YYYY-MM-DD) when the lowest balance is projected. */
  lowestDate: string | null;
  /** Full daily series. May be empty if the window is zero-length. */
  dailyPoints: { date: string; balance: number }[];
};

export type RunScenarioResult = {
  currency: string;
  dateFrom: string;
  dateTo: string;
  baseline: ScenarioForecastSummary;
  scenario: ScenarioForecastSummary;
  deltas: {
    /** scenario.closing − baseline.closing */
    closing: number;
    /** scenario.lowest − baseline.lowest */
    lowest: number;
    /**
     * Null when either side has no lowest-balance date (empty window).
     * When the scenario's lowest day differs from the baseline's, this
     * tells the UI which day to highlight on the scenario sparkline.
     */
    lowestDateChanged: boolean;
  };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(s: string): boolean {
  return ISO_DATE_RE.test(s);
}

/** Add `n` days to an ISO date string. */
function addDaysIso(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map((p) => parseInt(p, 10));
  const ms = Date.UTC(y, m - 1, d) + n * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

/** Convert AssumptionType to the ForecastOccurrence direction. */
function directionForAssumption(
  assumption: ScenarioAssumption,
): ForecastOccurrence['direction'] {
  switch (assumption.type) {
    case 'income':
      return 'in';
    case 'expense':
    case 'savings':
      return 'out';
    case 'one_off':
      // Fall back to 'out' when caller omits direction (conservative default).
      return assumption.direction === 'in' ? 'in' : 'out';
  }
}

/**
 * Convert an RRULE-style recurrence cadence to a mini RRULE string the
 * existing `expandRecurrence` helper understands.
 */
function recurrenceToRRule(rec: AssumptionRecurrence): string {
  switch (rec) {
    case 'weekly':
      return 'FREQ=WEEKLY';
    case 'biweekly':
      return 'FREQ=WEEKLY;INTERVAL=2';
    case 'monthly':
      return 'FREQ=MONTHLY';
  }
}

/**
 * Expand a ScenarioAssumption into dated ForecastOccurrences inside the
 * given window [windowFrom, windowTo].  Recurring assumptions respect
 * `endDate` as an upper cap in addition to `windowTo`.
 */
export function expandAssumption(
  assumption: ScenarioAssumption,
  windowFrom: string,
  windowTo: string,
  assumptionIndex: number,
): ForecastOccurrence[] {
  const amount = Math.abs(assumption.amount);
  if (!Number.isFinite(amount) || amount < 0) return [];
  if (!isValidDate(assumption.startDate)) return [];

  const direction = directionForAssumption(assumption);

  // One-off (no recurrence) — emit a single occurrence on startDate if in window.
  if (!assumption.recurrence) {
    const date = assumption.startDate;
    if (date < windowFrom || date > windowTo) return [];
    return [
      {
        date,
        amount,
        direction,
        sourceType: 'planned_event',
        sourceId: -(assumptionIndex + 1), // negative IDs to avoid collision with real events
        sourceName: assumption.label,
        accountId: null,
      },
    ];
  }

  // Recurring: cap the expansion window to the assumption's endDate.
  const effectiveWindowTo = assumption.endDate
    ? assumption.endDate < windowTo
      ? assumption.endDate
      : windowTo
    : windowTo;

  if (effectiveWindowTo < windowFrom) return [];

  // Delegate expansion to the same helper that the forecast engine uses.
  // We synthesise a minimal PlannedEventLike with the RRULE.
  const eventLike = {
    id: -(assumptionIndex + 1),
    expectedDate: assumption.startDate,
    recurrenceRule: recurrenceToRRule(assumption.recurrence),
    status: 'planned' as const,
  };

  const occs = expandRecurrence(eventLike, windowFrom, effectiveWindowTo);
  return occs.map((occ) => ({
    date: occ.date,
    amount,
    direction,
    sourceType: 'planned_event' as const,
    sourceId: -(assumptionIndex + 1),
    sourceName: assumption.label,
    accountId: null,
  }));
}

/** Summarize a BuildForecastResult into the compact ScenarioForecastSummary. */
function summarise(result: BuildForecastResult): ScenarioForecastSummary {
  return {
    closing: round2(result.projectedClosingBalance),
    lowest: round2(result.lowestProjectedBalance),
    lowestDate: result.lowestProjectedBalanceDate,
    dailyPoints: result.dailyPoints,
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Run the scenario planner: compare a baseline forecast to one where the
 * given assumptions are injected as additional events.
 *
 * @param baselineInput - Full BuildForecastInput for the baseline (real
 *   planned events + opening balance). Typically assembled by the route
 *   the same way GET /api/forecast does it.
 * @param assumptions - The list of hypothetical overrides.
 */
export function runScenario(
  baselineInput: BuildForecastInput,
  assumptions: ScenarioAssumption[],
): RunScenarioResult {
  // Build baseline (no assumption injections).
  const baselineResult = buildForecast(baselineInput);

  // Build scenario: inject assumption occurrences on top of baseline events.
  const assumptionOccurrences: ForecastOccurrence[] = assumptions.flatMap(
    (assumption, i) =>
      expandAssumption(
        assumption,
        baselineInput.dateFrom,
        baselineInput.dateTo,
        i,
      ),
  );

  const scenarioInput: BuildForecastInput = {
    ...baselineInput,
    occurrences: [...baselineInput.occurrences, ...assumptionOccurrences],
  };

  const scenarioResult = buildForecast(scenarioInput);

  const base = summarise(baselineResult);
  const scen = summarise(scenarioResult);

  return {
    currency: baselineInput.currency,
    dateFrom: baselineInput.dateFrom,
    dateTo: baselineInput.dateTo,
    baseline: base,
    scenario: scen,
    deltas: {
      closing: round2(scen.closing - base.closing),
      lowest: round2(scen.lowest - base.lowest),
      lowestDateChanged: scen.lowestDate !== base.lowestDate,
    },
  };
}

// Re-export addDaysIso so the route can use it without duplicating.
export { addDaysIso };
