/**
 * Period arithmetic for budgets: where the current period starts and ends, how
 * far through it we are, and the dedup key that names one instance of it.
 *
 * Everything here is pure and clock-injectable. It lives under `budgets/`
 * rather than in `routes/budgets.ts` so both the route layer and the breach
 * cron can depend on it without importing each other — the cron used to reach
 * into the route module for exactly these functions, and the shared spend
 * pipeline (`budgetSpend.ts`) needs them too, which would have closed the
 * import into a cycle.
 */
import type { BudgetTargetPeriod } from '../models/BudgetTarget';

export type PeriodBounds = { periodStart: string; periodEnd: string };

/**
 * Returns the inclusive [start, end] ISO date strings for the calendar month
 * containing `now`, in the local timezone. We deliberately use local time so
 * "this month" matches what a user sees on their phone calendar; date storage
 * on Transaction.date is DATEONLY (no TZ), and the dashboard date filter
 * already operates in local terms.
 */
export function currentMonthBounds(now: Date = new Date()): PeriodBounds {
  const y = now.getFullYear();
  const m = now.getMonth();
  const startDate = new Date(y, m, 1);
  const endDate = new Date(y, m + 1, 0);
  return { periodStart: formatLocalDate(startDate), periodEnd: formatLocalDate(endDate) };
}

export function formatLocalDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Returns the [start, end] of the ISO week (Mon → Sun) containing `now`.
 * ISO week was chosen because most finance UIs the user has encountered
 * (Google Calendar default, banking dashboards, payroll) use Mon-Sun;
 * it also matches the date-fns default `weekStartsOn: 1`. If a user wants
 * a Sun-Sat week later we can add a household-level setting and split here.
 */
export function currentWeekBounds(now: Date = new Date()): PeriodBounds {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // JS Date.getDay() returns 0 (Sun) through 6 (Sat).
  // Convert to Mon=0..Sun=6 so we can subtract back to Monday.
  const dayMondayBased = (today.getDay() + 6) % 7;
  const monday = new Date(today);
  monday.setDate(today.getDate() - dayMondayBased);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return {
    periodStart: formatLocalDate(monday),
    periodEnd: formatLocalDate(sunday),
  };
}

/** Returns the [Jan 1, Dec 31] bounds of the calendar year containing `now`. */
export function currentYearBounds(now: Date = new Date()): PeriodBounds {
  const y = now.getFullYear();
  return {
    periodStart: formatLocalDate(new Date(y, 0, 1)),
    periodEnd: formatLocalDate(new Date(y, 11, 31)),
  };
}

/**
 * Dispatch helper — pick the right bounds for a budget's `period`. Pure so
 * we can unit-test each branch without a DB. Default monthly is preserved
 * for back-compat with callers that pass `undefined`.
 *
 * Note this returns the bounds of the period CONTAINING the given instant, so
 * passing an arbitrary past date (not just "now") walks to that period — which
 * is how `priorPeriodAllowance` steps backwards through prior periods.
 */
export function currentPeriodBounds(
  period: BudgetTargetPeriod = 'monthly',
  now: Date = new Date()
): PeriodBounds {
  switch (period) {
    case 'weekly':
      return currentWeekBounds(now);
    case 'annual':
      return currentYearBounds(now);
    case 'monthly':
    default:
      return currentMonthBounds(now);
  }
}

/**
 * The period immediately before the one described by `bounds`. Implemented by
 * stepping one day back from the start and asking which period that day falls
 * in, so it inherits the month-length and ISO-week handling above rather than
 * duplicating it.
 */
export function previousPeriodBounds(
  period: BudgetTargetPeriod,
  bounds: PeriodBounds
): PeriodBounds {
  const dayBefore = new Date(`${bounds.periodStart}T00:00:00`);
  dayBefore.setDate(dayBefore.getDate() - 1);
  return currentPeriodBounds(period, dayBefore);
}

/** Inclusive day count of a period — 31 for January, 7 for any ISO week. */
export function periodDayCount(bounds: PeriodBounds): number {
  const startMs = Date.parse(`${bounds.periodStart}T00:00:00`);
  const endMs = Date.parse(`${bounds.periodEnd}T00:00:00`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;
  return Math.round((endMs - startMs) / 86400000) + 1;
}

/**
 * Percentage of the current period that has elapsed at `now`. Returns 0
 * before the period starts and 100 after it ends.
 *
 * Why fractional-day instead of floor((days_so_far / total_days) * 100)?
 * The pacing display feels jumpy at day boundaries — at 11:59 PM you're
 * 1/30 done and at 12:01 AM you're 2/30, a 3.3pp jump from one minute to
 * the next. Using `(now - start) / (end - start)` keeps the bar smooth and
 * makes the math match the spirit of "we're roughly N% through the month".
 */
export function periodElapsedPercent(now: Date, bounds: PeriodBounds): number {
  const startMs = Date.parse(`${bounds.periodStart}T00:00:00`);
  // periodEnd is the LAST day of the period (inclusive). Treat the end of
  // that day (23:59:59.999) as the boundary so the full last day counts.
  const endMs = Date.parse(`${bounds.periodEnd}T23:59:59.999`);
  const nowMs = now.getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return 0;
  }
  if (nowMs <= startMs) return 0;
  if (nowMs >= endMs) return 100;
  return ((nowMs - startMs) / (endMs - startMs)) * 100;
}

export type BudgetPacingState = 'on-pace' | 'ahead' | 'behind' | 'over';

/**
 * Classify a budget's current state by comparing how much of the target has
 * been used against how much of the period has elapsed. This is the
 * "Dining is 88% spent but the month is only 62% complete" headline.
 *
 *   over    — already past 100% of target (overspent).
 *   ahead   — spending faster than time elapsed (delta > 5pp).
 *   behind  — spending slower than time elapsed (delta < -5pp).
 *   on-pace — within ±5pp of elapsed.
 *
 * The ±5pp band keeps the badge from flickering when spend and time are
 * essentially matched. 5pp ≈ a day-and-a-half on a monthly budget, which
 * felt like a comfortable "noise floor" in design review.
 *
 * On a rollover budget `percentUsed` is measured against the carry-adjusted
 * effective target, so a well-funded envelope reads `behind` and one carrying
 * debt reads `over` before a dollar is spent. Both are the intended reading.
 */
export function pacingState(
  percentUsed: number,
  periodElapsed: number
): BudgetPacingState {
  if (percentUsed > 100) return 'over';
  const delta = percentUsed - periodElapsed;
  if (delta > 5) return 'ahead';
  if (delta < -5) return 'behind';
  return 'on-pace';
}

/**
 * Compute the period-key string used to dedup notifications. One key per
 * recurrence-period instance — i.e. the same monthly budget gets a fresh
 * key on the first day of every month, so prior-month alert states no
 * longer match and new alerts can fire.
 *
 * Format:
 *   monthly → 'YYYY-MM'   (e.g. '2026-05')
 *   weekly  → 'YYYY-Www'  (e.g. '2026-W21', ISO-week with Mon as first day)
 *   annual  → 'YYYY'      (e.g. '2026')
 *
 * Pure so the cron logic is unit-testable without a clock.
 */
export function periodKey(period: BudgetTargetPeriod, now: Date): string {
  const y = now.getFullYear();
  switch (period) {
    case 'annual':
      return String(y);
    case 'weekly': {
      // ISO week: week containing the year's first Thursday is week 1; weeks
      // start on Monday. Computed via the standard trick (shift to Thursday,
      // diff from Jan 4).
      const date = new Date(Date.UTC(y, now.getMonth(), now.getDate()));
      // getUTCDay: Sun=0..Sat=6. ISO uses Mon=1..Sun=7.
      const dayNum = date.getUTCDay() || 7;
      date.setUTCDate(date.getUTCDate() + 4 - dayNum);
      const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
      const weekNo = Math.ceil(
        ((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
      );
      return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
    }
    case 'monthly':
    default: {
      const m = String(now.getMonth() + 1).padStart(2, '0');
      return `${y}-${m}`;
    }
  }
}
