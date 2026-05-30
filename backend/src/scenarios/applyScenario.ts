/**
 * Pure scenario engine for the financial scenario planner (issue #213).
 *
 * The planner lets a user model hypothetical changes ("what if income drops
 * 30%?", "what if I save $2,000/month?", "what if I buy a car?") WITHOUT
 * mutating real transactions or planned events. The route layer collects the
 * current base inputs from the database (opening cash, forecast occurrences,
 * the safe-to-spend breakdown, current net worth); this engine applies the
 * assumptions to copies of those inputs, re-runs the existing forecast and
 * safe-to-spend math, and reports base vs scenario vs deltas.
 *
 * Keeping the math pure means it can be unit-tested without a database and
 * reuses the audited `buildForecast` / `composeSafeToSpend` primitives rather
 * than duplicating their logic.
 *
 * Scope note (#213, Option B): debt-payoff assumptions are intentionally NOT
 * modelled here yet — they depend on the debt payoff planner (#202), which is
 * still open. When #202 lands, add a `debt_payoff` assumption kind.
 */
import {
  buildForecast,
  type ForecastOccurrence,
} from '../forecast/buildForecast';
import {
  composeSafeToSpend,
  type SafeToSpendSettingsLike,
} from '../cashflow/safeToSpend';

/**
 * A single hypothetical change. Stored (as JSON) on the scenario row and
 * replayed by this engine.
 *
 * - income_pct: scale every income (direction 'in') occurrence by (1 + pct).
 *   pct = -0.3 models "income drops 30%"; pct = 0.1 models a 10% raise.
 * - expense_pct: scale every expense (direction 'out') occurrence by
 *   (1 + pct). pct = 0.05 models "rent / costs rise 5%".
 * - savings_monthly: park `amount` of cash each month across the horizon (a
 *   recurring outflow on the 1st of each month inside the window).
 * - one_off: a single dated event (buy a car, bonus, lump-sum debt payoff).
 */
export type ScenarioAssumption =
  | { kind: 'income_pct'; pct: number }
  | { kind: 'expense_pct'; pct: number }
  | { kind: 'savings_monthly'; amount: number }
  | { kind: 'one_off'; date: string; amount: number; direction: 'in' | 'out' };

export type ScenarioInputs = {
  /** Opening cash balance for the forecast window (single currency). */
  openingBalance: number;
  /** Base forecast occurrences (already expanded from planned events etc.). */
  occurrences: ForecastOccurrence[];
  /** YYYY-MM-DD forecast window start. Also the safe-to-spend asOfDate. */
  dateFrom: string;
  /** YYYY-MM-DD forecast window end. */
  dateTo: string;
  currency: string;

  // ----- Safe-to-spend base breakdown (already collected, currency-matched).
  currentCash: number;
  upcomingRequiredExpenses: number;
  requiredSavingsContributions: number;
  expectedCreditCardPayments: number;
  minimumBuffer: number;
  settings: SafeToSpendSettingsLike;

  /** Current net worth (CAD total) used as the scenario net-worth baseline. */
  currentNetWorth: number;
};

export type ScenarioMetrics = {
  projectedClosingBalance: number;
  lowestProjectedBalance: number;
  safeToSpend: number;
  netWorth: number;
};

export type ScenarioResult = {
  base: ScenarioMetrics;
  scenario: ScenarioMetrics;
  deltas: ScenarioMetrics;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map((p) => parseInt(p, 10));
  const ms = Date.UTC(y, m - 1, d) + days * MS_PER_DAY;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Month-start dates (YYYY-MM-01) that fall inside [from, to]. Used to lay out
 * recurring monthly savings contributions. We anchor to the 1st of each month
 * so the cadence is deterministic regardless of the window's start day.
 */
function monthStartsInRange(from: string, to: string): string[] {
  const out: string[] = [];
  const [fy, fm] = from.split('-').map((p) => parseInt(p, 10));
  // Start at the first month-start on or after `from`.
  let y = fy;
  let m = fm; // 1-based
  let cursor = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-01`;
  if (cursor < from) {
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
    cursor = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-01`;
  }
  while (cursor <= to) {
    out.push(cursor);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
    cursor = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-01`;
  }
  return out;
}

function syntheticOccurrence(
  date: string,
  amount: number,
  direction: 'in' | 'out',
  name: string,
): ForecastOccurrence {
  return {
    date,
    amount,
    direction,
    sourceType: 'planned_event',
    sourceId: -1,
    sourceName: name,
    accountId: null,
  };
}

/**
 * Build the safe-to-spend value for a given expense total, reusing the same
 * pure composer the production safe-to-spend endpoint uses so the math stays
 * in lockstep.
 */
function safeToSpendValue(
  inputs: ScenarioInputs,
  upcomingRequiredExpenses: number,
): number {
  const windowEndDate = addDaysIso(
    inputs.dateFrom,
    inputs.settings.safeToSpendWindowDays,
  );
  return composeSafeToSpend({
    currency: inputs.currency,
    asOfDate: inputs.dateFrom,
    windowDays: inputs.settings.safeToSpendWindowDays,
    windowEndDate,
    currentCash: inputs.currentCash,
    upcomingRequiredExpenses,
    requiredSavingsContributions: inputs.requiredSavingsContributions,
    expectedCreditCardPayments: inputs.expectedCreditCardPayments,
    minimumBuffer: inputs.minimumBuffer,
    settings: inputs.settings,
  }).value;
}

/**
 * Apply the assumptions to a copy of the base inputs and return base /
 * scenario / deltas.
 */
export function applyScenario(
  inputs: ScenarioInputs,
  assumptions: ScenarioAssumption[],
): ScenarioResult {
  // ----- Base metrics -----------------------------------------------------
  const baseForecast = buildForecast({
    openingBalance: inputs.openingBalance,
    occurrences: inputs.occurrences,
    dateFrom: inputs.dateFrom,
    dateTo: inputs.dateTo,
    currency: inputs.currency,
  });
  const baseSafeToSpend = safeToSpendValue(
    inputs,
    inputs.upcomingRequiredExpenses,
  );
  const base: ScenarioMetrics = {
    projectedClosingBalance: round2(baseForecast.projectedClosingBalance),
    lowestProjectedBalance: round2(baseForecast.lowestProjectedBalance),
    safeToSpend: round2(baseSafeToSpend),
    netWorth: round2(inputs.currentNetWorth),
  };

  // ----- Transform occurrences for the scenario ---------------------------
  const incomePct = assumptions
    .filter((a): a is Extract<ScenarioAssumption, { kind: 'income_pct' }> =>
      a.kind === 'income_pct',
    )
    .reduce((acc, a) => acc * (1 + a.pct), 1);
  const expensePct = assumptions
    .filter((a): a is Extract<ScenarioAssumption, { kind: 'expense_pct' }> =>
      a.kind === 'expense_pct',
    )
    .reduce((acc, a) => acc * (1 + a.pct), 1);

  const scenarioOccurrences: ForecastOccurrence[] = inputs.occurrences.map(
    (o) => {
      if (o.direction === 'in' && incomePct !== 1) {
        return { ...o, amount: o.amount * incomePct };
      }
      if (o.direction === 'out' && expensePct !== 1) {
        return { ...o, amount: o.amount * expensePct };
      }
      return o;
    },
  );

  const windowEndDate = addDaysIso(
    inputs.dateFrom,
    inputs.settings.safeToSpendWindowDays,
  );

  // Track how the scenario changes the safe-to-spend expense total. Only
  // outflows dated within the safe-to-spend window count, mirroring the
  // production safe-to-spend window semantics.
  let extraStsExpenses = 0;

  for (const a of assumptions) {
    if (a.kind === 'savings_monthly') {
      for (const date of monthStartsInRange(inputs.dateFrom, inputs.dateTo)) {
        scenarioOccurrences.push(
          syntheticOccurrence(date, a.amount, 'out', 'Hypothetical savings'),
        );
        if (date >= inputs.dateFrom && date <= windowEndDate) {
          extraStsExpenses += a.amount;
        }
      }
    } else if (a.kind === 'one_off') {
      scenarioOccurrences.push(
        syntheticOccurrence(a.date, a.amount, a.direction, 'One-off event'),
      );
      if (
        a.direction === 'out' &&
        a.date >= inputs.dateFrom &&
        a.date <= windowEndDate
      ) {
        extraStsExpenses += a.amount;
      }
    }
  }

  // ----- Scenario metrics -------------------------------------------------
  const scenarioForecast = buildForecast({
    openingBalance: inputs.openingBalance,
    occurrences: scenarioOccurrences,
    dateFrom: inputs.dateFrom,
    dateTo: inputs.dateTo,
    currency: inputs.currency,
  });
  const scenarioSafeToSpend = safeToSpendValue(
    inputs,
    inputs.upcomingRequiredExpenses + extraStsExpenses,
  );

  // Net worth moves with the change in projected cash: the cash that flows in
  // or out of the cashflow accounts shifts net worth by the same amount in
  // this forecast-only scope. (Asset re-pricing / debt amortization are out
  // of scope until the debt + portfolio scenario hooks land.)
  const cashDelta =
    scenarioForecast.projectedClosingBalance -
    baseForecast.projectedClosingBalance;
  const scenarioNetWorth = inputs.currentNetWorth + cashDelta;

  const scenario: ScenarioMetrics = {
    projectedClosingBalance: round2(scenarioForecast.projectedClosingBalance),
    lowestProjectedBalance: round2(scenarioForecast.lowestProjectedBalance),
    safeToSpend: round2(scenarioSafeToSpend),
    netWorth: round2(scenarioNetWorth),
  };

  const deltas: ScenarioMetrics = {
    projectedClosingBalance: round2(
      scenario.projectedClosingBalance - base.projectedClosingBalance,
    ),
    lowestProjectedBalance: round2(
      scenario.lowestProjectedBalance - base.lowestProjectedBalance,
    ),
    safeToSpend: round2(scenario.safeToSpend - base.safeToSpend),
    netWorth: round2(scenario.netWorth - base.netWorth),
  };

  return { base, scenario, deltas };
}
