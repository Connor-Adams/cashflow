/**
 * Owner-draw income for safe-to-spend (#990).
 *
 * The recurring-paycheck detector (`recurringIncome.ts`) assumes salaried
 * economics: a stable amount on a recognised cadence. An owner-operator pays
 * themselves by *drawing* money out of their corporation — variable amounts,
 * irregular timing, recorded as a `transfer`. Cadence matching will never fit
 * that shape, so this leg averages instead of detecting.
 *
 * A corp -> personal transfer IS personal income: it is a distribution crossing
 * the entity boundary, not an internal "move my own money" shuffle. Counting it
 * cannot double-count, because corp-entity accounts are already excluded from
 * safe-to-spend's cash leg — when the draw lands personally, genuinely new
 * spendable money enters the counted set.
 *
 * Pure module: the corp-link resolution that identifies a draw lives in
 * `safeToSpend.ts` (it needs the DB); the math lives here.
 */

export type OwnerDraw = {
  /** ISO `YYYY-MM-DD` date of the personal-side inflow. */
  date: string;
  /** Positive amount landing in the personal account. */
  amount: number;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function isoToMs(iso: string): number {
  const [y, m, d] = iso.split('-').map((p) => parseInt(p, 10));
  return Date.UTC(y, m - 1, d);
}

function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

/**
 * Trailing-average owner-draw income expected inside a `windowDays` window.
 *
 * Draws in `(asOfDate - lookbackDays, asOfDate]` are summed and divided by the
 * **full lookback**, not by the observed span between the first and last draw.
 * That choice is deliberate: dividing by the span would read two draws 13 days
 * apart as a $23k/month rate and keep projecting it at full strength forever,
 * even after the import goes stale. Dividing by the lookback makes a stale
 * import decay toward 0 instead — the conservative direction, since
 * over-counting income tells the user they can spend money they don't have.
 */
export function projectOwnerDrawIncome(
  draws: readonly OwnerDraw[],
  asOfDate: string,
  lookbackDays: number,
  windowDays: number,
): number {
  if (!Number.isFinite(lookbackDays) || lookbackDays <= 0) return 0;
  if (!Number.isFinite(windowDays) || windowDays <= 0) return 0;

  const asOfMs = isoToMs(asOfDate);
  const fromMs = asOfMs - lookbackDays * MS_PER_DAY;

  let total = 0;
  for (const draw of draws) {
    if (!Number.isFinite(draw.amount) || draw.amount <= 0) continue;
    const ms = isoToMs(draw.date);
    if (!Number.isFinite(ms)) continue;
    if (ms <= fromMs || ms > asOfMs) continue;
    total += draw.amount;
  }

  return round2((total / lookbackDays) * windowDays);
}
