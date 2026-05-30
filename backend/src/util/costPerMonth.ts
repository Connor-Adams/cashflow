/**
 * Pure helpers for the "cost per month owned" calculation that drives the
 * purchase intelligence feature (issue #218).
 *
 * The math is intentionally simple and deterministic so the same value can
 * be computed on the backend (for API responses) and verified by unit tests
 * without time-zone or locale surprises.
 *
 * Convention:
 * - amount is the absolute purchase price (always positive in inputs);
 *   callers pass `Math.abs(transaction.amount)` so refunds (positive raw
 *   amounts on a debit) don't flip the sign.
 * - elapsedMonths is calendar months between purchaseDate and asOf
 *   (rounded to one decimal of precision via a 30.4375 average day length).
 *   The minimum elapsed value is `1` so a brand-new purchase doesn't yield
 *   an infinity-sized cost (it costs $X for "this month so far").
 * - usefulLifeMonths, when provided, is the user's declared expected
 *   ownership duration. We cap the denominator at `usefulLifeMonths` if
 *   the item is younger than its life, but allow elapsed to exceed it
 *   (an asset still in service past its expected life has a lower
 *   amortised cost, which matches user intuition).
 *
 * All values are returned as plain numbers rounded to two decimal places —
 * the frontend formats with `formatMoney`.
 */

const AVERAGE_DAYS_PER_MONTH = 30.4375; // 365.25 / 12 — accounts for leap years
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Calendar months between two ISO date strings (YYYY-MM-DD). Returns a
 * non-negative number. If `asOf < purchaseDate`, returns 0.
 */
export function elapsedMonths(purchaseDateIso: string, asOfIso: string): number {
  const purchase = Date.parse(`${purchaseDateIso}T00:00:00Z`);
  const asOf = Date.parse(`${asOfIso}T00:00:00Z`);
  if (!Number.isFinite(purchase) || !Number.isFinite(asOf)) return 0;
  const days = (asOf - purchase) / MS_PER_DAY;
  if (days <= 0) return 0;
  return days / AVERAGE_DAYS_PER_MONTH;
}

export interface CostPerMonthInput {
  /** Absolute purchase amount (positive). */
  amountAbs: number;
  /** YYYY-MM-DD purchase date. */
  purchaseDate: string;
  /** YYYY-MM-DD reference date (typically today). */
  asOf: string;
  /** Optional declared useful life in months. */
  usefulLifeMonths?: number | null;
}

export interface CostPerMonthResult {
  /** Cost-per-month owned, rounded to 2 decimal places. */
  costPerMonth: number;
  /** Elapsed months actually used in the denominator (>= 1). */
  monthsOwned: number;
  /** Denominator used: usefulLife when set & < elapsed; otherwise elapsed. */
  denominatorMonths: number;
}

/**
 * Compute cost-per-month-owned. Returns 0/0/1 if amount <= 0 (no spend).
 *
 * Rules:
 * - `monthsOwned` is the raw elapsed months, floored at 1.
 * - When `usefulLifeMonths` is provided AND > 0, denominator is
 *   max(elapsedMonths, 1) capped at usefulLifeMonths during the asset's
 *   service life — but if the asset has aged past its declared life we use
 *   elapsedMonths so the displayed cost continues to decay.
 * - When `usefulLifeMonths` is null, denominator = monthsOwned.
 */
export function costPerMonth(input: CostPerMonthInput): CostPerMonthResult {
  const amount = Math.max(0, Number(input.amountAbs) || 0);
  const raw = elapsedMonths(input.purchaseDate, input.asOf);
  const monthsOwned = Math.max(1, raw);
  let denom = monthsOwned;
  if (input.usefulLifeMonths != null && input.usefulLifeMonths > 0) {
    // While the asset is younger than its declared life, depreciate over
    // its declared life (lower cost-per-month). Past its life, keep using
    // elapsed so the figure stays meaningful for assets that outlast plan.
    denom = Math.max(monthsOwned, input.usefulLifeMonths);
  }
  const result = amount === 0 ? 0 : amount / denom;
  return {
    costPerMonth: round2(result),
    monthsOwned: round2(monthsOwned),
    denominatorMonths: round2(denom),
  };
}

function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

/** Today as YYYY-MM-DD in UTC. Exported so callers (routes) can be consistent. */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
