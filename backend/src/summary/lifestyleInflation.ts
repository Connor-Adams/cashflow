/**
 * Pure aggregator for the "lifestyle inflation tracker" report (Cashflow #245).
 *
 * Lifestyle inflation is the slow creep where spending rises to match (or
 * outpace) rising income — savings stagnate even as you earn more. This
 * aggregator takes a rolling window of monthly transactions and answers:
 *
 *   - How did monthly income, spending, and savings trend over the window?
 *   - Is spending growing faster than income?
 *   - Which categories are driving the spend growth?
 *   - Should we warn the user (insight) that inflation is creeping in?
 *
 * Like explainMonth (#225) and partnerFairness (#207) it is HTTP- and
 * DB-agnostic: the route hands in plain rows (already scope/currency/
 * visibility filtered) plus the ordered month window, and this module does
 * the math. That keeps it trivially unit-testable and reusable from a job
 * runner later.
 *
 * "Growth" is computed as a first-half-vs-second-half average delta rather
 * than a regression slope. It is more intuitive for a money UI ("your last
 * 3 months averaged $2,200/mo, up from $1,000/mo") and robust to a single
 * noisy month. Months with no data are treated as zero, never dropped, so
 * the halves always span equal calendar time.
 *
 * Income classification mirrors explainMonth.tallyByCurrency: positive
 * amounts are income, negative amounts are spend (recorded as absolute
 * value). Pure money-movement rows — transfers, brokerage buys, dividends,
 * investment-account activity — are excluded via the shared
 * `isNonCategorical` filter so the trend reflects consumption, not
 * portfolio churn.
 */

import { num } from '../util/numbers';
import { isNonCategorical } from './classifyTransactionFlow';

/** Transaction row consumed by the aggregator. Mirrors the columns the
 *  route requests from Sequelize. */
export interface LifestyleInflationTxnRow {
  date: string; // YYYY-MM-DD
  currency: string;
  amount: unknown;
  finalCategory: string | null;
  txnType: string | null;
  accountType: string | null;
}

/** One month of aggregated totals for a single currency. */
export interface MonthlyPoint {
  month: string; // YYYY-MM
  income: number;
  spend: number;
  /** income - spend. Can be negative (spent more than earned that month). */
  savings: number;
}

/** First-half vs second-half averages for a metric over the window. */
export interface HalfAverages {
  firstHalfAvg: number;
  secondHalfAvg: number;
  /** secondHalfAvg - firstHalfAvg (absolute change in the per-month average). */
  delta: number;
}

/** A category's contribution to spend growth (first half avg -> second half). */
export interface CategoryDriver {
  category: string;
  firstHalfAvg: number;
  secondHalfAvg: number;
  /** secondHalfAvg - firstHalfAvg. Positive = spending more on this category. */
  delta: number;
  /** Percentage change in the per-month average, or null when the first-half
   *  baseline is zero (new category — pct is undefined, not infinite). */
  deltaPct: number | null;
}

export type LifestyleInflationSeverity = 'low' | 'medium' | 'high';

/** Warning surfaced when spend growth materially outpaces income growth. */
export interface LifestyleInflationInsight {
  kind: 'lifestyle_inflation';
  currency: string;
  severity: LifestyleInflationSeverity;
  title: string;
  summary: string;
  /** spendGrowthPct - incomeGrowthPct, in percentage points. */
  gapPct: number;
  meta: Record<string, unknown>;
}

export interface CurrencyTrend {
  currency: string;
  /** One entry per window month, ascending, including zero-filled months. */
  series: MonthlyPoint[];
  spendGrowth: HalfAverages;
  incomeGrowth: HalfAverages;
  savingsGrowth: HalfAverages;
  /** Percentage change in average monthly spend (second half vs first half),
   *  or null when the first-half baseline is zero. */
  spendGrowthPct: number | null;
  /** Percentage change in average monthly income, or null when the
   *  first-half baseline is zero (handles months with no income data). */
  incomeGrowthPct: number | null;
  savingsGrowthPct: number | null;
  /** True when spend grew faster than income by more than the threshold. */
  spendOutpacingIncome: boolean;
  /** Categories ranked by absolute spend-growth delta (descending). */
  categoryDrivers: CategoryDriver[];
  /** Warning insight, or null when spend is not outpacing income. */
  insight: LifestyleInflationInsight | null;
}

export interface LifestyleInflationInput {
  /** Ordered (ascending) YYYY-MM labels covering the window. Use
   *  buildMonthWindow() to produce this. */
  months: string[];
  transactions: LifestyleInflationTxnRow[];
  /** Currency filter (uppercase 3 letters) or null for all currencies. */
  currency: string | null;
  /** Percentage-point gap above which spend is considered to be outpacing
   *  income (spendGrowthPct - incomeGrowthPct > threshold). Default 10. */
  outpaceThresholdPct?: number;
  /** Cap on the number of category drivers returned. Default 5. */
  categoryDriverLimit?: number;
}

export interface LifestyleInflationResult {
  /** The window the report covers (echoed back for the UI). */
  windowMonths: string[];
  byCurrency: CurrencyTrend[];
}

const DEFAULT_OUTPACE_THRESHOLD_PCT = 10;
const DEFAULT_CATEGORY_DRIVER_LIMIT = 5;
const MIN_WINDOW_MONTHS = 2;

/** Year-month string ("2026-05") for an ISO date. */
function ymOf(date: string): string {
  return date.slice(0, 7);
}

/**
 * Build an ascending list of `count` YYYY-MM labels ending at (and including)
 * `anchorMonth`. A single month cannot express a trend, so `count` is floored
 * at 2. Year boundaries are handled without Date timezone semantics.
 */
export function buildMonthWindow(anchorMonth: string, count: number): string[] {
  const [yStr, mStr] = anchorMonth.split('-');
  let y = Number(yStr);
  let m = Number(mStr);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) {
    return [anchorMonth];
  }
  const n = Math.max(MIN_WINDOW_MONTHS, Math.trunc(count) || 0);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  return out.reverse();
}

interface MonthBucket {
  income: number;
  spend: number;
  byCategory: Map<string, number>; // category -> spend (absolute)
}

/** Average of a numeric list. Empty list -> 0 (a month with no data
 *  contributes a zero, so the divisor is the count of months, not entries). */
function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Percentage change from `from` to `to`. Null when the baseline is zero, so
 *  callers never surface Infinity/NaN for a new-from-nothing series. */
function pctChange(from: number, to: number): number | null {
  if (from === 0) return null;
  return ((to - from) / Math.abs(from)) * 100;
}

/** Split a per-month series into first/second halves. For odd lengths the
 *  extra (middle) month goes to the second half so recent activity weighs
 *  slightly more — the report is about where you're heading. */
function halves<T>(series: T[]): { first: T[]; second: T[] } {
  const mid = Math.floor(series.length / 2);
  return { first: series.slice(0, mid), second: series.slice(mid) };
}

function halfAverages(monthlyValues: number[]): HalfAverages {
  const { first, second } = halves(monthlyValues);
  const firstHalfAvg = avg(first);
  const secondHalfAvg = avg(second);
  return {
    firstHalfAvg,
    secondHalfAvg,
    delta: secondHalfAvg - firstHalfAvg,
  };
}

function severityForGap(gapPct: number, spendGrowthPct: number | null): LifestyleInflationSeverity {
  // High when the gap is large or spend roughly doubled; medium for a clear
  // but smaller creep; low otherwise (still emitted so the user sees it).
  if (gapPct >= 25 || (spendGrowthPct != null && spendGrowthPct >= 50)) return 'high';
  if (gapPct >= 15) return 'medium';
  return 'low';
}

function buildInsight(
  currency: string,
  gapPct: number,
  spendGrowthPct: number | null,
  incomeGrowthPct: number | null,
  spendGrowth: HalfAverages,
  incomeGrowth: HalfAverages,
  topDriver: CategoryDriver | undefined,
): LifestyleInflationInsight {
  const severity = severityForGap(gapPct, spendGrowthPct);
  const spendPctText =
    spendGrowthPct == null ? 'up' : `up ${spendGrowthPct.toFixed(0)}%`;
  const incomePctText =
    incomeGrowthPct == null
      ? 'flat'
      : incomeGrowthPct === 0
        ? 'flat'
        : `${incomeGrowthPct > 0 ? 'up' : 'down'} ${Math.abs(incomeGrowthPct).toFixed(0)}%`;
  const driverText = topDriver
    ? ` ${topDriver.category} is the biggest driver (+${topDriver.delta.toFixed(0)} ${currency}/mo).`
    : '';
  return {
    kind: 'lifestyle_inflation',
    currency,
    severity,
    title: `Spending is outpacing income in ${currency}`,
    summary:
      `Average monthly spending is ${spendPctText} ` +
      `(${spendGrowth.firstHalfAvg.toFixed(0)} -> ${spendGrowth.secondHalfAvg.toFixed(0)} ${currency}) ` +
      `while income is ${incomePctText} ` +
      `(${incomeGrowth.firstHalfAvg.toFixed(0)} -> ${incomeGrowth.secondHalfAvg.toFixed(0)} ${currency}).` +
      driverText,
    gapPct,
    meta: {
      spendGrowthPct,
      incomeGrowthPct,
      spendFirstHalfAvg: spendGrowth.firstHalfAvg,
      spendSecondHalfAvg: spendGrowth.secondHalfAvg,
      incomeFirstHalfAvg: incomeGrowth.firstHalfAvg,
      incomeSecondHalfAvg: incomeGrowth.secondHalfAvg,
      topDriverCategory: topDriver?.category ?? null,
    },
  };
}

function buildCategoryDrivers(
  buckets: Map<string, MonthBucket>,
  months: string[],
  limit: number,
): CategoryDriver[] {
  // Collect the union of categories seen across the window.
  const categories = new Set<string>();
  for (const b of buckets.values()) {
    for (const cat of b.byCategory.keys()) categories.add(cat);
  }
  const { first, second } = halves(months);
  const drivers: CategoryDriver[] = [];
  for (const category of categories) {
    const firstValues = first.map((m) => buckets.get(m)?.byCategory.get(category) ?? 0);
    const secondValues = second.map((m) => buckets.get(m)?.byCategory.get(category) ?? 0);
    const firstHalfAvg = avg(firstValues);
    const secondHalfAvg = avg(secondValues);
    const delta = secondHalfAvg - firstHalfAvg;
    drivers.push({
      category,
      firstHalfAvg,
      secondHalfAvg,
      delta,
      deltaPct: pctChange(firstHalfAvg, secondHalfAvg),
    });
  }
  // Rank by absolute growth so both surging and collapsing categories surface,
  // but drop dead-flat categories (delta 0) — they aren't "drivers".
  return drivers
    .filter((d) => Math.abs(d.delta) >= 0.005)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, limit);
}

function buildCurrencyTrend(
  currency: string,
  buckets: Map<string, MonthBucket>,
  months: string[],
  outpaceThresholdPct: number,
  categoryDriverLimit: number,
): CurrencyTrend {
  const series: MonthlyPoint[] = months.map((month) => {
    const b = buckets.get(month);
    const income = b?.income ?? 0;
    const spend = b?.spend ?? 0;
    return { month, income, spend, savings: income - spend };
  });

  const spendGrowth = halfAverages(series.map((m) => m.spend));
  const incomeGrowth = halfAverages(series.map((m) => m.income));
  const savingsGrowth = halfAverages(series.map((m) => m.savings));

  const spendGrowthPct = pctChange(spendGrowth.firstHalfAvg, spendGrowth.secondHalfAvg);
  const incomeGrowthPct = pctChange(incomeGrowth.firstHalfAvg, incomeGrowth.secondHalfAvg);
  const savingsGrowthPct = pctChange(savingsGrowth.firstHalfAvg, savingsGrowth.secondHalfAvg);

  // Compare growth rates. When income has no baseline (pct null) we treat its
  // growth as 0% for the comparison so a spend ramp on top of zero/flat income
  // still trips the warning — that's exactly the lifestyle-creep case.
  const spendPctForGap = spendGrowthPct ?? 0;
  const incomePctForGap = incomeGrowthPct ?? 0;
  const gapPct = spendPctForGap - incomePctForGap;
  const spendOutpacingIncome = gapPct > outpaceThresholdPct;

  const categoryDrivers = buildCategoryDrivers(buckets, months, categoryDriverLimit);

  const insight = spendOutpacingIncome
    ? buildInsight(
        currency,
        gapPct,
        spendGrowthPct,
        incomeGrowthPct,
        spendGrowth,
        incomeGrowth,
        categoryDrivers.find((d) => d.delta > 0),
      )
    : null;

  return {
    currency,
    series,
    spendGrowth,
    incomeGrowth,
    savingsGrowth,
    spendGrowthPct,
    incomeGrowthPct,
    savingsGrowthPct,
    spendOutpacingIncome,
    categoryDrivers,
    insight,
  };
}

export function lifestyleInflation(
  input: LifestyleInflationInput,
): LifestyleInflationResult {
  const months = input.months;
  const monthSet = new Set(months);
  const outpaceThresholdPct = input.outpaceThresholdPct ?? DEFAULT_OUTPACE_THRESHOLD_PCT;
  const categoryDriverLimit = input.categoryDriverLimit ?? DEFAULT_CATEGORY_DRIVER_LIMIT;
  const currencyFilter = input.currency;

  // currency -> (month -> bucket)
  const byCurrency = new Map<string, Map<string, MonthBucket>>();

  for (const txn of input.transactions) {
    if (currencyFilter && txn.currency !== currencyFilter) continue;
    if (isNonCategorical(txn.txnType, txn.accountType)) continue;
    const month = ymOf(txn.date);
    if (!monthSet.has(month)) continue;
    const amount = num(txn.amount);
    if (amount == null) continue;

    let months_ = byCurrency.get(txn.currency);
    if (!months_) {
      months_ = new Map<string, MonthBucket>();
      byCurrency.set(txn.currency, months_);
    }
    let bucket = months_.get(month);
    if (!bucket) {
      bucket = { income: 0, spend: 0, byCategory: new Map<string, number>() };
      months_.set(month, bucket);
    }
    if (amount < 0) {
      const abs = Math.abs(amount);
      bucket.spend += abs;
      const cat = txn.finalCategory ?? '(uncategorized)';
      bucket.byCategory.set(cat, (bucket.byCategory.get(cat) ?? 0) + abs);
    } else {
      bucket.income += amount;
    }
  }

  const trends: CurrencyTrend[] = [];
  for (const [currency, buckets] of byCurrency) {
    trends.push(
      buildCurrencyTrend(currency, buckets, months, outpaceThresholdPct, categoryDriverLimit),
    );
  }
  trends.sort((a, b) => a.currency.localeCompare(b.currency));

  return {
    windowMonths: months,
    byCurrency: trends,
  };
}
