/**
 * Pure projection math for financial goals (issue #203).
 *
 * Inputs all come from the DB row (strings for DECIMALs, dates as
 * YYYY-MM-DD or null). Outputs are JSON-safe primitives ready for the
 * API response.
 *
 * Conventions:
 * - Today is an injected parameter (YYYY-MM-DD) so callers — including
 *   tests — can pin the date. Production callers pass new Date().toISOString().slice(0,10).
 * - All money values returned as 4-decimal-place strings to match the
 *   DECIMAL(14,4) precision used elsewhere.
 * - Months between dates are calendar-month deltas (date1.year*12 + date1.month
 *   - date0.year*12 - date0.month). We always floor at 1 to avoid divide-by-zero
 *   and to keep "due this month" goals from collapsing to 0 months.
 *
 * Status semantics (when both target_date AND monthly_contribution are set):
 * - on_track:  monthly_contribution is within ±10% of required
 * - ahead:     monthly_contribution >= required * 1.1
 * - behind:    monthly_contribution <  required * 0.9
 *
 * When only one (or neither) is set:
 * - completed: current_amount >= target_amount (regardless of dates)
 * - no_target_date + has_monthly_contribution: status='active', projection
 *   includes a projectedCompletionDate
 * - has_target_date + no_monthly_contribution: status='unfunded', projection
 *   includes a requiredMonthlyContribution suggestion
 * - neither: status='active', no projection
 */

export type ProjectionStatus =
  | 'completed'
  | 'on_track'
  | 'ahead'
  | 'behind'
  | 'unfunded'
  | 'active';

export type GoalProjection = {
  /** Money remaining to reach the target, as a 4-decimal string. */
  remainingAmount: string;
  /** 0–100, two-decimal-place number for UI progress bars. */
  progressPercent: number;
  /**
   * Months from `today` to `target_date`, rounded down. Null when
   * target_date is null.
   */
  monthsRemaining: number | null;
  /**
   * Suggested monthly contribution to hit target_date. Null when
   * target_date is null OR when target is already reached.
   */
  requiredMonthlyContribution: string | null;
  /**
   * Projected completion date (YYYY-MM-DD) based on monthly_contribution.
   * Null when monthly_contribution is null/zero or target is already reached.
   */
  projectedCompletionDate: string | null;
  /** Derived status — see file-level comment. */
  status: ProjectionStatus;
};

export type GoalProjectionInput = {
  /** DECIMAL string, e.g. '5000.0000'. */
  targetAmount: string;
  /** DECIMAL string, e.g. '500.0000'. */
  currentAmount: string;
  /** YYYY-MM-DD or null. */
  targetDate: string | null;
  /** DECIMAL string or null. */
  monthlyContribution: string | null;
  /** YYYY-MM-DD — the date the projection is computed against. */
  today: string;
};

/** Parse a YYYY-MM-DD string into [year, monthIndex0-11, dayOfMonth]. */
function parseISODate(s: string): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  const day = Number(m[3]);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    month < 0 ||
    month > 11 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }
  return { year, month, day };
}

/** Format a JS Date as YYYY-MM-DD (UTC year-month-day). */
function formatISODate(year: number, monthIndex: number, day: number): string {
  // Normalize via Date so month/day overflow wraps correctly.
  const d = new Date(Date.UTC(year, monthIndex, day));
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/** Last day of a (year, 0-indexed month) — handles leap years via Date. */
function daysInMonth(year: number, monthIndex: number): number {
  // Day 0 of the next month = last day of the requested month.
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * Add `months` calendar months to (year, monthIndex0, day), clamping the
 * day-of-month to the last valid day of the resulting month. Jan 31 + 1
 * month is Feb 28/29, never an overflow into March. Mirrors the clamp logic
 * the forecast recurrence expander uses, so projection dates stay
 * calendar-correct instead of relying on Date's silent day overflow.
 */
function addMonthsClamped(
  year: number,
  monthIndex: number,
  day: number,
  months: number,
): string {
  const total = year * 12 + monthIndex + months;
  const ny = Math.floor(total / 12);
  const nm = ((total % 12) + 12) % 12;
  const clampedDay = Math.min(day, daysInMonth(ny, nm));
  return formatISODate(ny, nm, clampedDay);
}

/**
 * Calendar-month delta between two YYYY-MM-DD dates: `(b - a)` in months,
 * dropping the day-of-month for simplicity. Always >= 0; returns 0 when
 * `b <= a` calendar-month-wise.
 */
function monthsBetween(a: { year: number; month: number }, b: { year: number; month: number }): number {
  const delta = (b.year - a.year) * 12 + (b.month - a.month);
  return Math.max(0, delta);
}

/** Round a number to 4 decimals as a fixed-precision string. */
function toMoney(n: number): string {
  if (!Number.isFinite(n)) return '0.0000';
  return n.toFixed(4);
}

/**
 * Forecast-grounded goal status (issue #653). Distinct from {@link ProjectionStatus}
 * — this classifies a dated goal against *forecasted free cash* (what the real
 * forecast says the household can fund) rather than the goal's self-reported
 * `monthlyContribution`.
 *
 * - completed:     remaining <= 0 (honest regardless of free cash / currency).
 * - on_track:      free cash >= required * 0.9 (within a 10% tolerance).
 * - at_risk:       0 < free cash < required * 0.9.
 * - off_track:     free cash <= 0, OR the target date is already past and unmet.
 * - no_deadline:   goal has no target date → no deadline to validate against.
 * - cant_validate: goal currency ≠ forecast currency → we refuse to fake an FX
 *                  conversion and surface "can't validate" instead.
 */
export type ForecastGoalStatus =
  | 'completed'
  | 'on_track'
  | 'at_risk'
  | 'off_track'
  | 'no_deadline'
  | 'cant_validate';

export type ForecastGoalProjection = {
  /** The forecast currency this classification was computed in. */
  currency: string;
  /** Forecasted free cash per month, 4-decimal string. */
  monthlyFreeCash: string;
  /** Forecast-grounded status — see {@link ForecastGoalStatus}. */
  status: ForecastGoalStatus;
  /**
   * remaining / max(1, monthsRemaining) at 4dp. Null when there is no
   * classification to drive (no target date, completed, or currency mismatch).
   */
  requiredMonthlyContribution: string | null;
  /**
   * Projected completion date (YYYY-MM-DD) computed from forecasted free cash
   * (NOT the typed contribution). Null when free cash <= 0, completed, or
   * currency mismatch.
   */
  projectedCompletionDate: string | null;
  /** True when the goal currency differs from the forecast currency. */
  currencyMismatch: boolean;
};

export type ForecastGoalProjectionInput = {
  /** DECIMAL string, e.g. '5000.0000'. */
  targetAmount: string;
  /** DECIMAL string, e.g. '500.0000'. */
  currentAmount: string;
  /** YYYY-MM-DD or null. */
  targetDate: string | null;
  /** YYYY-MM-DD — the date the projection is computed against. */
  today: string;
  /** The goal's own currency (3-letter ISO). */
  goalCurrency: string;
  /** The forecast's currency (3-letter ISO). */
  forecastCurrency: string;
  /** Real forecasted free cash per month (may be negative). */
  forecastedMonthlyFreeCash: number;
};

/** -10% tolerance: free cash within 10% of required still counts as on track. */
const ON_TRACK_TOLERANCE = 0.9;

/**
 * Pure forecast-grounded goal classification (issue #653). Keeps {@link projectGoal}
 * untouched (still the self-reported view); this is the forecast-aware variant.
 * No DB, no clock — caller injects `today` and `forecastedMonthlyFreeCash`.
 */
export function projectGoalAgainstForecast(
  input: ForecastGoalProjectionInput,
): ForecastGoalProjection {
  const target = Number(input.targetAmount);
  const current = Number(input.currentAmount);
  const safeTarget = Number.isFinite(target) ? target : 0;
  const safeCurrent = Number.isFinite(current) ? current : 0;
  const remaining = Math.max(0, safeTarget - safeCurrent);

  const freeCash = Number.isFinite(input.forecastedMonthlyFreeCash)
    ? input.forecastedMonthlyFreeCash
    : 0;
  const monthlyFreeCash = toMoney(freeCash);
  const currency = input.forecastCurrency;
  const currencyMismatch =
    input.goalCurrency.trim().toUpperCase() !==
    input.forecastCurrency.trim().toUpperCase();

  const base = {
    currency,
    monthlyFreeCash,
    currencyMismatch,
  };

  // 1. Completed is honest regardless of free cash or currency.
  if (remaining <= 0) {
    return {
      ...base,
      status: 'completed',
      requiredMonthlyContribution: null,
      projectedCompletionDate: null,
    };
  }

  // 2. Currency mismatch → refuse to fake an FX conversion.
  if (currencyMismatch) {
    return {
      ...base,
      status: 'cant_validate',
      requiredMonthlyContribution: null,
      projectedCompletionDate: null,
    };
  }

  // Projected completion date is driven by free cash, not the typed
  // contribution — available for both dated and undated goals.
  const today = parseISODate(input.today);
  let projectedCompletionDate: string | null = null;
  if (freeCash > 0 && today) {
    const monthsToFinish = Math.ceil(remaining / freeCash);
    projectedCompletionDate = addMonthsClamped(
      today.year,
      today.month,
      today.day,
      monthsToFinish,
    );
  }

  // 3. No target date → no deadline to validate.
  const targetDateParsed = input.targetDate ? parseISODate(input.targetDate) : null;
  if (!targetDateParsed || !today) {
    return {
      ...base,
      status: 'no_deadline',
      requiredMonthlyContribution: null,
      projectedCompletionDate,
    };
  }

  // 4. Dated, unmet, same-currency goal → classify against free cash.
  const monthsRemaining = monthsBetween(today, targetDateParsed);
  const requiredMonthly = remaining / Math.max(1, monthsRemaining);

  let status: ForecastGoalStatus;
  if (freeCash <= 0 || (monthsRemaining === 0 && remaining > 0)) {
    // No/negative free cash, OR the deadline has already passed unmet —
    // mathematically impossible to fund at the current forecasted pace.
    status = 'off_track';
  } else if (freeCash >= requiredMonthly * ON_TRACK_TOLERANCE) {
    status = 'on_track';
  } else {
    status = 'at_risk';
  }

  return {
    ...base,
    status,
    requiredMonthlyContribution: toMoney(requiredMonthly),
    projectedCompletionDate,
  };
}

export function projectGoal(input: GoalProjectionInput): GoalProjection {
  const target = Number(input.targetAmount);
  const current = Number(input.currentAmount);
  const safeTarget = Number.isFinite(target) ? target : 0;
  const safeCurrent = Number.isFinite(current) ? current : 0;
  const remaining = Math.max(0, safeTarget - safeCurrent);

  // Progress percent — clamp [0, 100] to handle data quirks (negative
  // current, or over-contribution past target).
  let progressPercent = 0;
  if (safeTarget > 0) {
    progressPercent = Math.max(
      0,
      Math.min(100, (safeCurrent / safeTarget) * 100),
    );
    // Two decimals max for clean UI display.
    progressPercent = Math.round(progressPercent * 100) / 100;
  }

  const today = parseISODate(input.today);
  const targetDateParsed = input.targetDate ? parseISODate(input.targetDate) : null;
  const monthlyContribution = input.monthlyContribution != null
    ? Number(input.monthlyContribution)
    : null;
  const safeMonthly = monthlyContribution != null && Number.isFinite(monthlyContribution)
    ? Math.max(0, monthlyContribution)
    : null;

  // Early-out: already completed.
  if (remaining <= 0) {
    return {
      remainingAmount: '0.0000',
      progressPercent,
      monthsRemaining: targetDateParsed && today
        ? monthsBetween(today, targetDateParsed)
        : null,
      requiredMonthlyContribution: null,
      projectedCompletionDate: null,
      status: 'completed',
    };
  }

  // Compute monthsRemaining (null when no target_date).
  let monthsRemaining: number | null = null;
  let requiredMonthly: number | null = null;
  if (targetDateParsed && today) {
    monthsRemaining = monthsBetween(today, targetDateParsed);
    // Use Math.max(1, ...) for the divisor to avoid /0 and to keep
    // "this month" goals from showing 0 required (they need the full amount).
    const divisor = Math.max(1, monthsRemaining);
    requiredMonthly = remaining / divisor;
  }

  // Compute projectedCompletionDate when monthly_contribution > 0.
  let projectedCompletion: string | null = null;
  if (safeMonthly != null && safeMonthly > 0 && today) {
    const monthsToFinish = Math.ceil(remaining / safeMonthly);
    projectedCompletion = addMonthsClamped(
      today.year,
      today.month,
      today.day,
      monthsToFinish,
    );
  }

  // Derive status.
  let status: ProjectionStatus;
  if (requiredMonthly != null && safeMonthly != null && safeMonthly > 0) {
    // Both target_date and monthly_contribution are set.
    if (safeMonthly >= requiredMonthly * 1.1) {
      status = 'ahead';
    } else if (safeMonthly < requiredMonthly * 0.9) {
      status = 'behind';
    } else {
      status = 'on_track';
    }
  } else if (requiredMonthly != null && (safeMonthly == null || safeMonthly === 0)) {
    // Has deadline but no contribution intent.
    status = 'unfunded';
  } else {
    // No deadline, or no contribution intent — just "active".
    status = 'active';
  }

  return {
    remainingAmount: toMoney(remaining),
    progressPercent,
    monthsRemaining,
    requiredMonthlyContribution:
      requiredMonthly != null ? toMoney(requiredMonthly) : null,
    projectedCompletionDate: projectedCompletion,
    status,
  };
}
