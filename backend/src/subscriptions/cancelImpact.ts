/**
 * Pure cancel-impact helpers for the subscription optimizer (Cashflow #291).
 *
 * "Cancel impact" answers: if the user cancels this subscription, how much do
 * they save over the next N months at its current cadence? The figure powers
 * the inline cancel-impact card and the cancel confirmation dialog, so it must
 * be deterministic and cheap to compute. Keeping it free of DB/Express makes
 * the math trivially unit-testable.
 *
 * The amount field on a Subscription is the *per-period* charge (e.g. the
 * monthly price for a monthly cadence, the yearly price for an annual one).
 * To project a horizon we multiply that per-period charge by the number of
 * occurrences that fall inside the horizon.
 */
import type { SubscriptionCadence } from '../models/PlannedEvent';

const MONTHS_PER_YEAR = 12;

/**
 * Occurrences per year for each cadence. Weekly is approximated at 52
 * occurrences/year (the standard billing-cycle approximation); the rest divide
 * the year cleanly.
 */
const PERIODS_PER_YEAR: Record<SubscriptionCadence, number> = {
  weekly: 52,
  monthly: 12,
  quarterly: 4,
  semiannual: 2,
  annual: 1,
};

/** Occurrences per year for a cadence. */
export function periodsPerYear(cadence: SubscriptionCadence): number {
  return PERIODS_PER_YEAR[cadence];
}

/**
 * Forecast horizons offered in the UI. v1 supports a fixed set (6 / 12 / 24
 * months) — custom horizons are explicitly out of scope.
 */
export const ALLOWED_HORIZON_MONTHS: readonly number[] = [6, 12, 24] as const;

/** Whether a horizon value is one of the supported {6, 12, 24} months. */
export function isAllowedHorizon(horizonMonths: unknown): horizonMonths is number {
  return (
    typeof horizonMonths === 'number' &&
    Number.isInteger(horizonMonths) &&
    ALLOWED_HORIZON_MONTHS.includes(horizonMonths)
  );
}

export interface CancelImpactInput {
  /** Per-period charge amount. Sign-agnostic — charges may arrive negative. */
  perPeriodAmount: number;
  cadence: SubscriptionCadence;
  /** Forecast horizon in months — expected to be one of ALLOWED_HORIZON_MONTHS. */
  horizonMonths: number;
}

export interface CancelImpactResult {
  /** Projected total spend over the horizon, rounded to two decimals. */
  amount: number;
  /**
   * Number of expected occurrences inside the horizon. Fractional when a
   * cadence period only partially fits the horizon (annual over 6 months →
   * 0.5 expected renewals).
   */
  count: number;
  /** Echoes the horizon used, for client convenience. */
  horizonMonths: number;
}

/**
 * Project the total spend (== potential savings) of a subscription over a
 * horizon. The occurrence count is `periodsPerYear * horizonMonths / 12`,
 * kept exact rather than rounded: every cadence/horizon combination in
 * {6, 12, 24} divides evenly except annual over 6 months (0.5), and rounding
 * that up would claim a full year's charge saved inside six months. With no
 * renewal date to consult, the expectation is the honest figure. The amount
 * is the absolute per-period charge times that count, rounded to two
 * decimals.
 */
export function computeCancelImpact(input: CancelImpactInput): CancelImpactResult {
  const perPeriod = Math.abs(input.perPeriodAmount);
  const periods = periodsPerYear(input.cadence);
  const count = (periods * input.horizonMonths) / MONTHS_PER_YEAR;
  const amount = Math.round(perPeriod * count * 100) / 100;
  return { amount, count, horizonMonths: input.horizonMonths };
}
