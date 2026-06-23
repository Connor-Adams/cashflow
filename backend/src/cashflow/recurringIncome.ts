/**
 * Recurring-income detection for safe-to-spend's income leg.
 *
 * `detectRecurringIncome` finds high-confidence recurring inflows (paychecks)
 * in a transaction history; `projectRecurringIncome` sums the occurrences that
 * fall inside the spending window. Both are pure.
 *
 * Detection is intentionally CONSERVATIVE: over-counting income inflates
 * safe-to-spend, which is the dangerous direction. A stream qualifies only when
 * it has >= 3 occurrences, a recognised cadence with consistent spacing,
 * amounts within 20% of the median, and a last occurrence recent enough that
 * the stream is still active.
 */

export type IncomeTxn = { date: string; amount: number; merchant: string };

export type RecurringIncomeStream = {
  merchant: string;
  /** Representative (median) per-occurrence amount, positive. */
  amount: number;
  cadenceDays: number;
  lastDate: string;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MIN_OCCURRENCES = 3;
const AMOUNT_TOLERANCE = 0.2; // within 20% of the median amount
/** Recognised pay cadences (days): weekly, biweekly, semimonthly, monthly. */
const KNOWN_CADENCES = [7, 14, 15, 30];

function isoToMs(iso: string): number {
  const [y, m, d] = iso.split('-').map((p) => parseInt(p, 10));
  return Date.UTC(y, m - 1, d);
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Nearest recognised cadence to a median gap, or null if none is close. */
function classifyCadence(medianGap: number): number | null {
  for (const c of KNOWN_CADENCES) {
    const tol = c <= 14 ? 2 : 4;
    if (Math.abs(medianGap - c) <= tol) return c;
  }
  return null;
}

export function detectRecurringIncome(
  txns: IncomeTxn[],
  asOfDate: string,
): RecurringIncomeStream[] {
  const groups = new Map<string, IncomeTxn[]>();
  for (const t of txns) {
    if (!(t.amount > 0)) continue;
    const key = t.merchant.trim().toUpperCase();
    if (!key) continue;
    const bucket = groups.get(key);
    if (bucket) bucket.push(t);
    else groups.set(key, [t]);
  }

  const asOfMs = isoToMs(asOfDate);
  const out: RecurringIncomeStream[] = [];
  for (const [key, items] of groups) {
    if (items.length < MIN_OCCURRENCES) continue;
    const sorted = [...items].sort((a, b) => isoToMs(a.date) - isoToMs(b.date));

    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      gaps.push((isoToMs(sorted[i].date) - isoToMs(sorted[i - 1].date)) / MS_PER_DAY);
    }
    const cadence = classifyCadence(median(gaps));
    if (cadence == null) continue;

    // Every gap must be consistent with the cadence (reject the odd long break).
    const gapTol = cadence <= 14 ? 3 : 6;
    if (!gaps.every((g) => Math.abs(g - cadence) <= gapTol)) continue;

    // Amounts must cluster — a stable paycheck, not lumpy gig income.
    const amounts = sorted.map((s) => s.amount);
    const medAmt = median(amounts);
    if (medAmt <= 0) continue;
    if (!amounts.every((a) => Math.abs(a - medAmt) / medAmt <= AMOUNT_TOLERANCE)) {
      continue;
    }

    // Still active: the last occurrence is within 1.5 cadences of today.
    const lastMs = isoToMs(sorted[sorted.length - 1].date);
    if (asOfMs - lastMs > 1.5 * cadence * MS_PER_DAY) continue;

    out.push({
      merchant: key,
      amount: round2(medAmt),
      cadenceDays: cadence,
      lastDate: sorted[sorted.length - 1].date,
    });
  }
  return out;
}

export function projectRecurringIncome(
  streams: RecurringIncomeStream[],
  windowStartIso: string,
  windowEndIso: string,
): number {
  const startMs = isoToMs(windowStartIso);
  const endMs = isoToMs(windowEndIso);
  let total = 0;
  for (const s of streams) {
    const step = s.cadenceDays * MS_PER_DAY;
    if (step <= 0) continue;
    let occ = isoToMs(s.lastDate) + step;
    let guard = 0;
    while (occ <= endMs && guard++ < 1000) {
      if (occ >= startMs) total += s.amount;
      occ += step;
    }
  }
  return round2(total);
}
