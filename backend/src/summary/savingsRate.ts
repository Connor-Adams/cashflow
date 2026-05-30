/**
 * Pure aggregator for the "savings rate dashboard" (Cashflow #246).
 *
 * Calculates monthly income, spending, savings, investments, and debt
 * principal breakdown. Supports configurable inclusion of investments
 * and debt principal in the savings rate numerator.
 *
 * Reuses the pure aggregator pattern from explainMonth (#225) —
 * HTTP- and DB-agnostic, deterministic, unit-testable.
 */

import { num } from '../util/numbers';
import { isNonCategorical } from './classifyTransactionFlow';

/** Transaction row consumed by the aggregator. */
export interface SavingsRateTxnRow {
  id: number;
  date: string; // YYYY-MM-DD
  currency: string;
  amount: unknown;
  accountId: number;
  accountType: string; // 'checking', 'savings', 'investment', 'loan', 'credit_card', etc.
  txnType: string | null;
  finalCategory: string | null;
  finalBusiness: boolean;
  linkedTransactionId: number | null;
}

/** Monthly breakdown for a single currency. */
export interface SavingsRateMonthlyPoint {
  month: string; // YYYY-MM
  income: number;
  spending: number;
  savings: number;
  investments: number;
  debtPrincipal: number;
  savingsRate: number | null; // Percentage, null if income is zero
}

/** Response for a single currency's trend over a window. */
export interface SavingsRateCurrencyTrend {
  currency: string;
  /** One entry per month in the window, ascending, zero-filled. */
  series: SavingsRateMonthlyPoint[];
  /** Aggregated totals across the window. */
  totals: {
    income: number;
    spending: number;
    savings: number;
    investments: number;
    debtPrincipal: number;
    avgSavingsRate: number | null; // Average of monthly rates (weighted or simple avg)
  };
}

/** Full response combining all currencies in the household. */
export interface SavingsRateResponse {
  /** Map of currency → trend. */
  currencyTrends: Record<string, SavingsRateCurrencyTrend>;
  /** Ordered list of months in the window (YYYY-MM). */
  months: string[];
  /** Query options echoed back. */
  options: {
    includeInvestments: boolean;
    includeDebtPrincipal: boolean;
  };
}

/**
 * Classify a transaction row and extract its contribution to each category.
 * Returns { income, spending, savings, investments, debtPrincipal } — only
 * one is nonzero per row (exclusive classification).
 * Returns all zeros for invalid (null amount) or non-categorical rows.
 */
function classifyTxn(row: SavingsRateTxnRow): {
  income: number;
  spending: number;
  savings: number;
  investments: number;
  debtPrincipal: number;
} {
  const amount = num(row.amount);
  if (amount == null) {
    return { income: 0, spending: 0, savings: 0, investments: 0, debtPrincipal: 0 };
  }

  const isNegative = amount < 0;

  // Skip non-categorical and internal transfers (zero-sum across the pair).
  // A linked transfer is counted only once: on the destination account.
  // We'll handle this in the caller by filtering to only one leg.
  if (isNonCategorical(row.txnType, row.accountType)) {
    return { income: 0, spending: 0, savings: 0, investments: 0, debtPrincipal: 0 };
  }

  // Income: positive amounts (excluding payments, handled by isNonCategorical filter)
  if (amount > 0 && row.txnType !== 'payment') {
    return { income: amount, spending: 0, savings: 0, investments: 0, debtPrincipal: 0 };
  }

  // Negative amounts (outflows) go to spending unless landing on savings/investment/loan.
  if (isNegative) {
    const dest = row.accountType;

    // Savings account: negative outflow = deposit to savings
    if (dest === 'savings') {
      return { income: 0, spending: 0, savings: -amount, investments: 0, debtPrincipal: 0 };
    }

    // Investment account or txnType='investment': count as investment
    if (dest === 'investment' || row.txnType === 'investment') {
      return { income: 0, spending: 0, savings: 0, investments: -amount, debtPrincipal: 0 };
    }

    // Loan/credit_card account: principal payment
    if (dest === 'loan' || dest === 'credit_card') {
      return { income: 0, spending: 0, savings: 0, investments: 0, debtPrincipal: -amount };
    }

    // Default: regular spending
    return { income: 0, spending: -amount, savings: 0, investments: 0, debtPrincipal: 0 };
  }

  // Positive amounts (inflows) on special accounts
  if (amount > 0) {
    const dest = row.accountType;

    // Investment account or txnType='investment': count as investment
    if (dest === 'investment' || row.txnType === 'investment') {
      return { income: 0, spending: 0, savings: 0, investments: amount, debtPrincipal: 0 };
    }

    // Loan/credit_card account: principal payment
    if (dest === 'loan' || dest === 'credit_card') {
      return { income: 0, spending: 0, savings: 0, investments: 0, debtPrincipal: amount };
    }

    // Savings account deposit
    if (dest === 'savings') {
      return { income: 0, spending: 0, savings: amount, investments: 0, debtPrincipal: 0 };
    }

    // Default income
    return { income: amount, spending: 0, savings: 0, investments: 0, debtPrincipal: 0 };
  }

  return { income: 0, spending: 0, savings: 0, investments: 0, debtPrincipal: 0 };
}

/**
 * Main aggregator. Takes transaction rows and a month window, returns
 * monthly breakdown per currency.
 *
 * @param rows — Transaction rows, pre-filtered by visibility/scope.
 * @param months — Ordered list of YYYY-MM months in the window.
 * @param includeInvestments — If false, investments don't count toward numerator.
 * @param includeDebtPrincipal — If false, debt principal doesn't count toward numerator.
 */
export function savingsRate(
  rows: SavingsRateTxnRow[],
  months: string[],
  includeInvestments: boolean = true,
  includeDebtPrincipal: boolean = true,
): SavingsRateResponse {
  // Group rows by currency and month
  const byCurrency = new Map<string, Map<string, SavingsRateMonthlyPoint>>();

  for (const row of rows) {
    const monthKey = row.date.slice(0, 7); // YYYY-MM
    if (!months.includes(monthKey)) continue; // Skip rows outside window

    if (!byCurrency.has(row.currency)) {
      byCurrency.set(row.currency, new Map());
    }

    const byMonth = byCurrency.get(row.currency)!;
    if (!byMonth.has(monthKey)) {
      byMonth.set(monthKey, {
        month: monthKey,
        income: 0,
        spending: 0,
        savings: 0,
        investments: 0,
        debtPrincipal: 0,
        savingsRate: null,
      });
    }

    const point = byMonth.get(monthKey)!;
    const classified = classifyTxn(row);
    point.income += classified.income;
    point.spending += classified.spending;
    point.savings += classified.savings;
    point.investments += classified.investments;
    point.debtPrincipal += classified.debtPrincipal;
  }

  // Build response: fill in missing months with zeros, compute savings rate
  const currencyTrends: Record<string, SavingsRateCurrencyTrend> = {};

  for (const [currency, byMonth] of byCurrency) {
    const series: SavingsRateMonthlyPoint[] = [];
    let totalIncome = 0;
    let totalSpending = 0;
    let totalSavings = 0;
    let totalInvestments = 0;
    let totalDebtPrincipal = 0;
    let rateCount = 0;
    let rateSum = 0;

    for (const month of months) {
      const point = byMonth.get(month) || {
        month,
        income: 0,
        spending: 0,
        savings: 0,
        investments: 0,
        debtPrincipal: 0,
        savingsRate: null,
      };

      // Calculate savings rate for this month
      if (point.income > 0) {
        const numerator =
          point.savings +
          (includeInvestments ? point.investments : 0) +
          (includeDebtPrincipal ? point.debtPrincipal : 0);
        point.savingsRate = (numerator / point.income) * 100;
        rateSum += point.savingsRate;
        rateCount += 1;
      }

      series.push(point);
      totalIncome += point.income;
      totalSpending += point.spending;
      totalSavings += point.savings;
      totalInvestments += point.investments;
      totalDebtPrincipal += point.debtPrincipal;
    }

    // Average savings rate across months with income
    const avgSavingsRate = rateCount > 0 ? rateSum / rateCount : null;

    currencyTrends[currency] = {
      currency,
      series,
      totals: {
        income: totalIncome,
        spending: totalSpending,
        savings: totalSavings,
        investments: totalInvestments,
        debtPrincipal: totalDebtPrincipal,
        avgSavingsRate,
      },
    };
  }

  return {
    currencyTrends,
    months,
    options: {
      includeInvestments,
      includeDebtPrincipal,
    },
  };
}
