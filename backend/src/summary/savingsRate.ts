/**
 * Pure aggregator for the "savings rate dashboard" report (Cashflow #246).
 *
 * The true savings rate answers: of the money you brought in this month, what
 * fraction did you keep — as cash savings, investment contributions, and debt
 * principal paid down — rather than spend? Tracking it over time shows whether
 * you're building wealth or treading water.
 *
 *   savingsRate = (savings + [investments] + [debtPrincipal]) / income
 *
 * Like explainMonth (#225) and lifestyleInflation (#245) this module is HTTP-
 * and DB-agnostic: the route hands in plain rows (already scope / currency /
 * visibility filtered) plus the ordered month window, and this module does the
 * classification and math. That keeps it trivially unit-testable and reusable
 * from a job runner later.
 *
 * ## Classification (by the row's OWN account type + sign + txnType)
 *
 * Each transaction is a single signed amount on a single account. We classify
 * each row by the account it lands on, which makes internal transfers self-
 * netting and impossible to double count:
 *
 *   - income       — a positive inflow on a cash account (checking/cash) that
 *                     reads as a genuine credit (not a statement payment, not a
 *                     money-movement transfer). Reuses `classifyPositiveAmount`.
 *   - spending     — a negative amount on a cash / credit-card account that is
 *                     real consumption (not a transfer / brokerage flow).
 *                     Recorded as its absolute value.
 *   - savings      — a positive amount landing ON a savings account (a deposit).
 *   - investments  — a positive amount on an investment account, OR a row whose
 *                     txnType is `investment`, OR a transfer whose
 *                     transferPurpose is `investment`.
 *   - debtPrincipal— a positive amount (a payment) landing on a liability
 *                     account (loan / mortgage / credit card). This is the
 *                     principal you paid down; the matching outflow leg lives on
 *                     your checking account and is skipped as a transfer.
 *
 * A transfer from checking to savings therefore contributes nothing on the
 * checking side (the outflow leg is money-movement, skipped) and a `savings`
 * amount on the savings side — counted exactly once. The same holds for
 * investment and debt-payment transfers.
 *
 * `includeInvestments` and `includeDebtPrincipal` (both default true) control
 * only whether those components are added to the savings-rate NUMERATOR — the
 * components are always reported so the UI can show the full breakdown and the
 * toggles can re-derive the rate client-side if desired.
 */

import { num } from '../util/numbers';
import { classifyPositiveAmount, isNonCategorical } from './classifyTransactionFlow';

/** Account types treated as cash savings vehicles. */
const SAVINGS_ACCOUNT_TYPES: ReadonlySet<string> = new Set(['savings']);
/** Account types treated as investment vehicles. */
const INVESTMENT_ACCOUNT_TYPES: ReadonlySet<string> = new Set(['investment']);
/**
 * Account types treated as liabilities. Mirrors networth/accountKind plus the
 * legacy `credit` spelling that some seeds / imports use for credit cards.
 */
const LIABILITY_ACCOUNT_TYPES: ReadonlySet<string> = new Set([
  'credit_card',
  'credit',
  'loan',
  'mortgage',
]);

/** Transaction row consumed by the aggregator. Mirrors the columns the route
 *  requests from Sequelize. */
export interface SavingsRateTxnRow {
  date: string; // YYYY-MM-DD
  currency: string;
  amount: unknown;
  txnType: string | null;
  transferPurpose: string | null;
  accountType: string | null;
}

/** One month of aggregated components + savings rate for a single currency. */
export interface SavingsRateMonthlyPoint {
  month: string; // YYYY-MM
  income: number;
  spending: number;
  savings: number;
  investments: number;
  debtPrincipal: number;
  /** (savings + [investments] + [debtPrincipal]) / income, as a percentage.
   *  Null when there is no income for the month (avoids divide-by-zero). */
  savingsRatePct: number | null;
}

/** Window-level totals for a currency, plus the average savings rate. */
export interface SavingsRateTotals {
  income: number;
  spending: number;
  savings: number;
  investments: number;
  debtPrincipal: number;
  /** Savings rate computed on the window totals (more stable than averaging
   *  the per-month rates). Null when total income is zero. */
  savingsRatePct: number | null;
}

export interface SavingsRateCurrencySummary {
  currency: string;
  /** One entry per window month, ascending, including zero-filled months. */
  series: SavingsRateMonthlyPoint[];
  totals: SavingsRateTotals;
}

export interface SavingsRateInput {
  /** Ordered (ascending) YYYY-MM labels covering the window. Use
   *  buildMonthWindow() (from lifestyleInflation) to produce this. */
  months: string[];
  transactions: SavingsRateTxnRow[];
  /** Currency filter (uppercase 3 letters) or null for all currencies. */
  currency: string | null;
  /** Count investment contributions toward the savings rate. Default true. */
  includeInvestments?: boolean;
  /** Count debt-principal paydown toward the savings rate. Default true. */
  includeDebtPrincipal?: boolean;
}

export interface SavingsRateResult {
  /** The window the report covers (echoed back for the UI). */
  windowMonths: string[];
  includeInvestments: boolean;
  includeDebtPrincipal: boolean;
  byCurrency: SavingsRateCurrencySummary[];
}

type Bucket = 'income' | 'spending' | 'savings' | 'investments' | 'debtPrincipal' | 'skip';

interface MonthBucket {
  income: number;
  spending: number;
  savings: number;
  investments: number;
  debtPrincipal: number;
}

/** Year-month string ("2026-05") for an ISO date. */
function ymOf(date: string): string {
  return String(date).slice(0, 7);
}

function isSavingsAccount(accountType: string | null): boolean {
  return accountType != null && SAVINGS_ACCOUNT_TYPES.has(accountType);
}
function isInvestmentAccount(accountType: string | null): boolean {
  return accountType != null && INVESTMENT_ACCOUNT_TYPES.has(accountType);
}
function isLiabilityAccount(accountType: string | null): boolean {
  return accountType != null && LIABILITY_ACCOUNT_TYPES.has(accountType);
}

/**
 * Classify a single row into its savings-rate bucket. Pure and side-effect
 * free so it can be unit-tested in isolation and reasoned about row-by-row.
 *
 * Resolution order matters: investment/debt signals on a transfer's
 * destination leg must win over the generic transfer skip, and the savings
 * deposit must win before we fall back to income.
 */
export function classifySavingsRow(row: SavingsRateTxnRow): Bucket {
  const amount = num(row.amount);
  if (amount == null) return 'skip';
  const accountType = row.accountType;

  // --- positive amounts: an inflow landing somewhere ---
  if (amount > 0) {
    // Investment contribution: explicit txnType / transferPurpose, or any
    // positive amount on a brokerage account.
    if (
      row.txnType === 'investment' ||
      row.transferPurpose === 'investment' ||
      isInvestmentAccount(accountType)
    ) {
      return 'investments';
    }
    // Deposit into a savings account.
    if (isSavingsAccount(accountType)) return 'savings';
    // Payment landing on a liability account pays down principal.
    if (isLiabilityAccount(accountType)) return 'debtPrincipal';
    // Otherwise it's a cash-account inflow — income only if it reads as a
    // genuine credit (statement payments / transfers / dividends are skipped).
    return classifyPositiveAmount({ txnType: row.txnType, accountType }) === 'credit'
      ? 'income'
      : 'skip';
  }

  // --- negative amounts: an outflow ---
  // Money-movement outflows (the source leg of a transfer, brokerage sells,
  // dividend sweeps, investment-account activity) are not spending — they net
  // against the inflow leg we already classified above.
  if (isNonCategorical(row.txnType, accountType)) return 'skip';
  // A negative on an investment account is portfolio churn, never spend.
  if (isInvestmentAccount(accountType)) return 'skip';
  // Everything else negative is real consumption.
  return 'spending';
}

function emptyBucket(): MonthBucket {
  return { income: 0, spending: 0, savings: 0, investments: 0, debtPrincipal: 0 };
}

/** Numerator of the savings rate given the configured inclusions. */
function numerator(
  b: { savings: number; investments: number; debtPrincipal: number },
  includeInvestments: boolean,
  includeDebtPrincipal: boolean,
): number {
  return (
    b.savings +
    (includeInvestments ? b.investments : 0) +
    (includeDebtPrincipal ? b.debtPrincipal : 0)
  );
}

/** Savings rate as a percentage, or null when income is zero. */
function rate(income: number, num_: number): number | null {
  if (income <= 0) return null;
  return (num_ / income) * 100;
}

export function savingsRate(input: SavingsRateInput): SavingsRateResult {
  const months = input.months;
  const monthSet = new Set(months);
  const currencyFilter = input.currency;
  const includeInvestments = input.includeInvestments ?? true;
  const includeDebtPrincipal = input.includeDebtPrincipal ?? true;

  // currency -> (month -> bucket)
  const byCurrency = new Map<string, Map<string, MonthBucket>>();

  for (const txn of input.transactions) {
    if (currencyFilter && txn.currency !== currencyFilter) continue;
    const month = ymOf(txn.date);
    if (!monthSet.has(month)) continue;
    const amount = num(txn.amount);
    if (amount == null) continue;
    const bucketKind = classifySavingsRow(txn);
    if (bucketKind === 'skip') continue;

    let monthsMap = byCurrency.get(txn.currency);
    if (!monthsMap) {
      monthsMap = new Map<string, MonthBucket>();
      byCurrency.set(txn.currency, monthsMap);
    }
    let bucket = monthsMap.get(month);
    if (!bucket) {
      bucket = emptyBucket();
      monthsMap.set(month, bucket);
    }
    const abs = Math.abs(amount);
    bucket[bucketKind] += abs;
  }

  const summaries: SavingsRateCurrencySummary[] = [];
  for (const [currency, buckets] of byCurrency) {
    const series: SavingsRateMonthlyPoint[] = months.map((month) => {
      const b = buckets.get(month) ?? emptyBucket();
      const num_ = numerator(b, includeInvestments, includeDebtPrincipal);
      return {
        month,
        income: b.income,
        spending: b.spending,
        savings: b.savings,
        investments: b.investments,
        debtPrincipal: b.debtPrincipal,
        savingsRatePct: rate(b.income, num_),
      };
    });

    const totals: SavingsRateTotals = series.reduce<SavingsRateTotals>(
      (acc, m) => {
        acc.income += m.income;
        acc.spending += m.spending;
        acc.savings += m.savings;
        acc.investments += m.investments;
        acc.debtPrincipal += m.debtPrincipal;
        return acc;
      },
      {
        income: 0,
        spending: 0,
        savings: 0,
        investments: 0,
        debtPrincipal: 0,
        savingsRatePct: null,
      },
    );
    totals.savingsRatePct = rate(
      totals.income,
      numerator(totals, includeInvestments, includeDebtPrincipal),
    );

    summaries.push({ currency, series, totals });
  }
  summaries.sort((a, b) => a.currency.localeCompare(b.currency));

  return {
    windowMonths: months,
    includeInvestments,
    includeDebtPrincipal,
    byCurrency: summaries,
  };
}
