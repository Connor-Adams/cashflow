/**
 * Income detector for the cashflow forecast.
 *
 * The forecast's expense side projects recurring charges from transaction
 * history (see detectRecurring in routes/recurring.ts), but income was never
 * projected — so a user with no manually-entered income Expectation saw a
 * forecast that only ever declined ("the forecast doesn't think I'll ever
 * earn another dollar again").
 *
 * The hard part is that real income is frequently tagged the same as internal
 * money-movement. In the reference data, payroll arrives as
 * "Direct deposit from <employer>" with txn_type='transfer' — identical to a
 * self-transfer between the user's own accounts. So we DO NOT detect income by
 * merchant-blind recurrence (that would count internal top-ups as income, and
 * double-count against the matching outflow). Instead the signal is:
 *
 *   - txn_type === 'income' (when the enrichment pipeline tagged it), OR
 *   - the description matches a direct-deposit / payroll pattern.
 *
 * Income history is sparse and lumpy (payroll is monthly; only a couple of
 * deposits may be imported, with varying amounts), so the default occurrence
 * threshold is lower than the expense detector's, and amount variance does not
 * disqualify a stream — the description match is the precision signal.
 *
 * Pure function: no DB, no clock. Callers filter/shape the input and project
 * the returned streams forward over the forecast window.
 */

export type IncomeInputTxn = {
  /** merchantClean || merchantRaw — the human description of the row. */
  merchant: string | null;
  /** Enrichment txn type, e.g. 'income' | 'transfer' | null. */
  txnType: string | null;
  /** Signed amount; income is a positive inflow. */
  amount: number;
  currency: string;
  /** YYYY-MM-DD. */
  date: string;
};

export type IncomeCadence = 'weekly' | 'biweekly' | 'monthly';

export type DetectedIncome = {
  /** Display name of the payer/stream (the first occurrence's description). */
  source: string;
  currency: string;
  cadence: IncomeCadence;
  occurrences: number;
  /** Mean inflow amount (positive). */
  avgAmount: number;
  /** YYYY-MM-DD of the most recent detected deposit. */
  lastSeen: string;
  /** YYYY-MM-DD of the next projected deposit (lastSeen + one cadence step). */
  nextExpected: string;
};

export type DetectIncomeOptions = {
  /** Minimum deposits before a stream is projected. Default 2. */
  minOccurrences?: number;
};

const DEFAULT_MIN_OCCURRENCES = 2;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const WEEKLY_MIN_GAP_DAYS = 6;
const WEEKLY_MAX_GAP_DAYS = 8;
const BIWEEKLY_MIN_GAP_DAYS = 12;
const BIWEEKLY_MAX_GAP_DAYS = 16;

/**
 * Description patterns that mark a positive row as genuine income rather than
 * an internal transfer. Deliberately specific: "transfer" / "e-transfer" /
 * "from <account>" must NOT match.
 */
const INCOME_TEXT_PATTERNS: readonly RegExp[] = [
  /\bdirect deposit\b/,
  /\bdirectdep/,
  /\bpayroll\b/,
  /\bsalary\b/,
  /\bpaycheck\b/,
  /\bpaycheque\b/,
];

function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function looksLikeIncomeText(merchant: string | null): boolean {
  if (!merchant) return false;
  const text = normalizeText(merchant);
  if (!text) return false;
  return INCOME_TEXT_PATTERNS.some((re) => re.test(text));
}

function isIncomeRow(txn: IncomeInputTxn): boolean {
  if (!Number.isFinite(txn.amount) || txn.amount <= 0) return false;
  if (txn.txnType === 'income') return true;
  return looksLikeIncomeText(txn.merchant);
}

function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map((p) => parseInt(p, 10));
  const ms = Date.UTC(y, m - 1, d) + days * MS_PER_DAY;
  return new Date(ms).toISOString().slice(0, 10);
}

function addMonthsIso(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map((p) => parseInt(p, 10));
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const daysInMonth = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return new Date(Date.UTC(ny, nm - 1, Math.min(d, daysInMonth)))
    .toISOString()
    .slice(0, 10);
}

function classifyCadence(sortedDates: string[]): IncomeCadence {
  if (sortedDates.length < 2) return 'monthly';
  const ms = sortedDates.map((s) => Date.parse(s));
  let totalGap = 0;
  for (let i = 1; i < ms.length; i += 1) {
    totalGap += (ms[i] - ms[i - 1]) / MS_PER_DAY;
  }
  const meanGap = totalGap / (ms.length - 1);
  if (meanGap >= WEEKLY_MIN_GAP_DAYS && meanGap <= WEEKLY_MAX_GAP_DAYS) {
    return 'weekly';
  }
  if (meanGap >= BIWEEKLY_MIN_GAP_DAYS && meanGap <= BIWEEKLY_MAX_GAP_DAYS) {
    return 'biweekly';
  }
  return 'monthly';
}

function stepCadence(iso: string, cadence: IncomeCadence): string {
  switch (cadence) {
    case 'weekly':
      return addDaysIso(iso, 7);
    case 'biweekly':
      return addDaysIso(iso, 14);
    case 'monthly':
      return addMonthsIso(iso, 1);
  }
}

/**
 * Group income-looking inflows by (description, currency) and return one
 * projected stream per group with at least `minOccurrences` deposits.
 */
export function detectRecurringIncome(
  txns: IncomeInputTxn[],
  opts: DetectIncomeOptions = {},
): DetectedIncome[] {
  const minOccurrences = Math.max(1, opts.minOccurrences ?? DEFAULT_MIN_OCCURRENCES);

  type Group = { source: string; currency: string; amounts: number[]; dates: string[] };
  const groups = new Map<string, Group>();

  for (const txn of txns) {
    if (!isIncomeRow(txn)) continue;
    const display = (txn.merchant ?? '').trim();
    if (!display) continue;
    const key = `${normalizeText(display)}|${txn.currency}`;
    let group = groups.get(key);
    if (!group) {
      group = { source: display, currency: txn.currency, amounts: [], dates: [] };
      groups.set(key, group);
    }
    group.amounts.push(txn.amount);
    group.dates.push(txn.date);
  }

  const items: DetectedIncome[] = [];
  for (const group of groups.values()) {
    const occurrences = group.dates.length;
    if (occurrences < minOccurrences) continue;

    const sortedDates = [...group.dates].sort((a, b) => a.localeCompare(b));
    const cadence = classifyCadence(sortedDates);
    const avgAmount =
      group.amounts.reduce((acc, v) => acc + v, 0) / group.amounts.length;
    const lastSeen = sortedDates[sortedDates.length - 1];

    items.push({
      source: group.source,
      currency: group.currency,
      cadence,
      occurrences,
      avgAmount,
      lastSeen,
      nextExpected: stepCadence(lastSeen, cadence),
    });
  }

  items.sort((a, b) => b.avgAmount - a.avgAmount);
  return items;
}
