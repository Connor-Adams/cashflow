/**
 * Pure forecast engine for #198. Given:
 *   - opening cash balance (one currency, already netted across accounts
 *     that contribute to cashflow — investment accounts are excluded by
 *     the caller because portfolio market value is not part of "cash to
 *     spend")
 *   - a list of dated occurrences (income / expense / transfer / etc.,
 *     already expanded from recurrence rules)
 *   - a [dateFrom, dateTo] window
 * produces the dailyPoints series, projectedClosingBalance, and
 * lowestProjectedBalance the GET /forecast endpoint returns.
 *
 * Math is done in integer cents to avoid float drift across long ranges.
 * (The forecast can be 90 days long with daily compounding of many small
 * charges; floats would accumulate visible rounding error.)
 */

export type ForecastOccurrence = {
  /** YYYY-MM-DD */
  date: string;
  /** Absolute amount, always non-negative; direction encodes sign. */
  amount: number;
  /**
   * 'in'  → adds to balance (income, refund)
   * 'out' → subtracts from balance (expense, debt payment)
   * 'neutral' → does not move household-level cash (transfer between own
   *             accounts, partner settlement that nets to zero, savings
   *             contribution earmarked rather than spent)
   */
  direction: 'in' | 'out' | 'neutral';
  sourceType: 'planned_event' | 'recurring_detection';
  sourceId: number;
  sourceName: string;
  accountId: number | null;
};

export type ForecastDailyPoint = {
  date: string;
  balance: number;
};

export type BuildForecastInput = {
  openingBalance: number;
  occurrences: ForecastOccurrence[];
  dateFrom: string;
  dateTo: string;
  currency: string;
};

export type BuildForecastResult = {
  openingBalance: number;
  projectedClosingBalance: number;
  lowestProjectedBalance: number;
  lowestProjectedBalanceDate: string | null;
  dailyPoints: ForecastDailyPoint[];
};

function isValidDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function nextDay(iso: string): string {
  const [y, m, d] = iso.split('-').map((p) => parseInt(p, 10));
  const ms = Date.UTC(y, m - 1, d) + 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Convert a JS number of dollars to integer hundredths-of-a-cent (4dp). */
function toUnits(n: number): number {
  // We keep 4 decimal places of precision to match DECIMAL(14,4) used
  // elsewhere in the codebase. Rounding here makes summation associative.
  return Math.round(n * 10000);
}

/** Convert integer 4-dp units back to a 2dp money number for display. */
function fromUnits(units: number): number {
  return Math.round(units / 100) / 100;
}

export function buildForecast(input: BuildForecastInput): BuildForecastResult {
  const { openingBalance, occurrences, dateFrom, dateTo } = input;

  if (!isValidDate(dateFrom) || !isValidDate(dateTo) || dateTo < dateFrom) {
    return {
      openingBalance,
      projectedClosingBalance: openingBalance,
      lowestProjectedBalance: openingBalance,
      lowestProjectedBalanceDate: null,
      dailyPoints: [],
    };
  }

  // Bucket occurrences by date. Filter out anything outside the window
  // and anything with direction === 'neutral' (no balance impact).
  const deltaByDate = new Map<string, number>();
  for (const occ of occurrences) {
    if (occ.direction === 'neutral') continue;
    if (occ.date < dateFrom || occ.date > dateTo) continue;
    const signed = occ.direction === 'in' ? toUnits(occ.amount) : -toUnits(occ.amount);
    deltaByDate.set(occ.date, (deltaByDate.get(occ.date) ?? 0) + signed);
  }

  const dailyPoints: ForecastDailyPoint[] = [];
  let runningUnits = toUnits(openingBalance);
  let lowestUnits = runningUnits;
  let lowestDate: string | null = null;

  let cursor = dateFrom;
  while (cursor <= dateTo) {
    const delta = deltaByDate.get(cursor) ?? 0;
    runningUnits += delta;
    if (lowestDate === null || runningUnits < lowestUnits) {
      lowestUnits = runningUnits;
      lowestDate = cursor;
    }
    dailyPoints.push({ date: cursor, balance: fromUnits(runningUnits) });
    cursor = nextDay(cursor);
  }

  const closing = fromUnits(runningUnits);
  const lowest = fromUnits(lowestUnits);

  return {
    openingBalance,
    projectedClosingBalance: closing,
    lowestProjectedBalance: lowest,
    lowestProjectedBalanceDate: lowestDate,
    dailyPoints,
  };
}
