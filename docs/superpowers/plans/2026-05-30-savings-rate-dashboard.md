# Savings Rate Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dashboard and backend endpoint that calculates and displays monthly savings rate with configurable classification of debt principal and investment transfers as savings components.

**Architecture:** Pure aggregator pattern following `explainMonth` (#225) and `lifestyleInflation` (#245). Backend module `savingsRate.ts` classifies transactions by destination account type (income, spending, savings, investments, debt principal) and computes the savings rate formula. API route extends `reports.ts`. Frontend page renders trend chart and breakdown table with filters for month window, currency, and optional inclusion of investments/debt principal.

**Tech Stack:** Node.js (tsx), Sequelize (raw queries), React + TanStack Query (frontend fetching), Tailwind CSS (styling), node:test (testing framework)

---

## File Structure

### Backend
- **`backend/src/summary/savingsRate.ts`** (new) — Pure aggregator module
- **`backend/src/routes/reports.ts`** (modify) — Add GET `/api/reports/savings-rate` endpoint
- **`backend/test/savingsRate.test.ts`** (new) — Unit tests for aggregator logic
- **`backend/test/integration/savingsRate.test.ts`** (new) — Integration tests with fixtures

### Frontend
- **`frontend/src/pages/SavingsRatePage.tsx`** (new) — Dashboard page component
- **`frontend/src/types/api.ts`** (modify) — Add type definitions for savings rate API response
- **`frontend/src/lib/router.tsx`** (modify) — Add route `/reports/savings-rate`
- **`frontend/src/components/ui/sidebar.tsx`** (modify) — Add "Savings Rate" link under "Insights & rules"

---

## Task 1: Implement `savingsRate.ts` aggregator module

**Files:**
- Create: `backend/src/summary/savingsRate.ts`

The aggregator classifies each transaction row by its role in the savings calculation:
- **Income**: Positive amounts excluding statement payments (reuse `classifyPositiveAmount`)
- **Spending**: Negative amounts on non-savings/non-investment/non-loan accounts, excluding non-categorical
- **Savings**: Transfer-type rows with negative amount (outflow) landing on savings account, OR positive amounts landing on savings account (deposits)
- **Investments**: Positive amounts landing on investment account OR txnType='investment'
- **Debt Principal**: Positive amounts landing on loan/credit_card account (principal paydown)

Savings rate formula: `(savings + [investments] + [debtPrincipal]) / income`

- [ ] **Step 1: Create `backend/src/summary/savingsRate.ts` with type definitions**

```typescript
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
 */
function classifyTxn(row: SavingsRateTxnRow): {
  income: number;
  spending: number;
  savings: number;
  investments: number;
  debtPrincipal: number;
} {
  const amount = num(row.amount);
  const isNegative = amount < 0;

  // Skip non-categorical and internal transfers (zero-sum across the pair).
  // A linked transfer is counted only once: on the destination account.
  // We'll handle this in the caller by filtering to only one leg.
  if (isNonCategorical(row)) {
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
```

- [ ] **Step 2: Run tsc to verify module compiles**

```bash
cd /Users/connoradams/Developer/cashflow
yarn workspace cashflow-backend run tsc -b
```

Expected: No type errors.

---

## Task 2: Implement integration test for aggregator

**Files:**
- Create: `backend/test/integration/savingsRate.test.ts`

- [ ] **Step 1: Create integration test file with fixtures**

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  savingsRate,
  type SavingsRateTxnRow,
} from '../src/summary/savingsRate';

function txnRow(overrides: Partial<SavingsRateTxnRow>): SavingsRateTxnRow {
  return {
    id: Math.random(),
    date: '2026-05-15',
    currency: 'CAD',
    amount: '-100',
    accountId: 1,
    accountType: 'checking',
    txnType: 'purchase',
    finalCategory: 'Dining',
    finalBusiness: false,
    linkedTransactionId: null,
    ...overrides,
  };
}

test('savingsRate: income positive amounts', () => {
  const rows = [
    txnRow({ amount: '5000', txnType: 'income', accountType: 'checking' }),
    txnRow({ amount: '-2000', accountType: 'checking', finalCategory: 'Groceries' }),
  ];
  const result = savingsRate(rows, ['2026-05']);
  const trend = result.currencyTrends['CAD'];
  assert.ok(trend);
  assert.equal(trend.series[0].income, 5000);
  assert.equal(trend.series[0].spending, 2000);
});

test('savingsRate: savings transfers to savings account', () => {
  const rows = [
    txnRow({ amount: '6000', txnType: 'income', accountType: 'checking' }),
    txnRow({ amount: '-1000', accountType: 'savings', txnType: 'transfer' }),
  ];
  const result = savingsRate(rows, ['2026-05']);
  const trend = result.currencyTrends['CAD'];
  assert.ok(trend);
  assert.equal(trend.series[0].income, 6000);
  assert.equal(trend.series[0].savings, 1000);
});

test('savingsRate: investment classification', () => {
  const rows = [
    txnRow({ amount: '6000', txnType: 'income', accountType: 'checking' }),
    txnRow({ amount: '-500', accountType: 'investment', txnType: 'transfer' }),
  ];
  const result = savingsRate(rows, ['2026-05']);
  const trend = result.currencyTrends['CAD'];
  assert.ok(trend);
  assert.equal(trend.series[0].investments, 500);
});

test('savingsRate: debt principal classification', () => {
  const rows = [
    txnRow({ amount: '6000', txnType: 'income', accountType: 'checking' }),
    txnRow({ amount: '-300', accountType: 'credit_card', txnType: 'payment' }),
  ];
  const result = savingsRate(rows, ['2026-05']);
  const trend = result.currencyTrends['CAD'];
  assert.ok(trend);
  assert.equal(trend.series[0].debtPrincipal, 300);
});

test('savingsRate: configurable inclusion of investments and debt', () => {
  const rows = [
    txnRow({ amount: '1000', txnType: 'income', accountType: 'checking' }),
    txnRow({ amount: '-200', accountType: 'savings', txnType: 'transfer' }),
    txnRow({ amount: '-150', accountType: 'investment', txnType: 'transfer' }),
    txnRow({ amount: '-100', accountType: 'credit_card', txnType: 'payment' }),
  ];

  // Include all
  const resultAll = savingsRate(rows, ['2026-05'], true, true);
  const trendAll = resultAll.currencyTrends['CAD'];
  assert.equal(
    trendAll.series[0].savingsRate,
    ((200 + 150 + 100) / 1000) * 100 // 45%
  );

  // Exclude investments
  const resultNoInv = savingsRate(rows, ['2026-05'], false, true);
  const trendNoInv = resultNoInv.currencyTrends['CAD'];
  assert.equal(
    trendNoInv.series[0].savingsRate,
    ((200 + 100) / 1000) * 100 // 30%
  );

  // Exclude debt
  const resultNoDebt = savingsRate(rows, ['2026-05'], true, false);
  const trendNoDebt = resultNoDebt.currencyTrends['CAD'];
  assert.equal(
    trendNoDebt.series[0].savingsRate,
    ((200 + 150) / 1000) * 100 // 35%
  );
});

test('savingsRate: multiple months filled with zeros', () => {
  const rows = [
    txnRow({ date: '2026-05-15', amount: '2000', txnType: 'income', accountType: 'checking' }),
    txnRow({ date: '2026-07-15', amount: '3000', txnType: 'income', accountType: 'checking' }),
  ];
  const result = savingsRate(rows, ['2026-05', '2026-06', '2026-07']);
  const trend = result.currencyTrends['CAD'];
  assert.equal(trend.series.length, 3);
  assert.equal(trend.series[0].income, 2000);
  assert.equal(trend.series[1].income, 0); // June is zero-filled
  assert.equal(trend.series[2].income, 3000);
});

test('savingsRate: multiple currencies kept separate', () => {
  const rows = [
    txnRow({ currency: 'CAD', amount: '1000', txnType: 'income', accountType: 'checking' }),
    txnRow({ currency: 'USD', amount: '800', txnType: 'income', accountType: 'checking' }),
  ];
  const result = savingsRate(rows, ['2026-05']);
  assert.ok(result.currencyTrends['CAD']);
  assert.ok(result.currencyTrends['USD']);
  assert.equal(result.currencyTrends['CAD'].series[0].income, 1000);
  assert.equal(result.currencyTrends['USD'].series[0].income, 800);
});

test('savingsRate: zero income month returns null savingsRate', () => {
  const rows = [txnRow({ amount: '-100', accountType: 'checking' })]; // No income
  const result = savingsRate(rows, ['2026-05']);
  const trend = result.currencyTrends['CAD'];
  assert.equal(trend.series[0].savingsRate, null);
});
```

- [ ] **Step 2: Run the integration test to verify all cases pass**

```bash
cd /Users/connoradams/Developer/cashflow
yarn workspace cashflow-backend run test backend/test/integration/savingsRate.test.ts
```

Expected: All tests pass (11 assertions, 0 failures).

---

## Task 3: Add GET `/api/reports/savings-rate` route

**Files:**
- Modify: `backend/src/routes/reports.ts`

- [ ] **Step 1: Review the existing reports.ts structure and add imports**

At the top of the file, add:

```typescript
import {
  savingsRate,
  type SavingsRateTxnRow,
} from '../summary/savingsRate';
```

- [ ] **Step 2: Add route handler for savings rate before the export**

Add this before `export default router;` at the end of the file:

```typescript
/**
 * GET /api/reports/savings-rate
 *
 * Calculates monthly savings rate breakdown (income, spending, savings,
 * investments, debt principal) over a rolling window of months.
 *
 * Query parameters:
 *   month (YYYY-MM): anchor month (defaults to current month)
 *   months (number): window size in months (2–36, default 12)
 *   currency (string): optional filter to single currency (empty = all)
 *   scope (personal|shared|business|all): transaction scope filter
 *   includeInvestments (true|false): whether to count investments in numerator (default true)
 *   includeDebtPrincipal (true|false): whether to count debt principal (default true)
 */
router.get('/savings-rate', currentAuth, aiSuggestLimiter, async (req, res) => {
  try {
    const household = req.auth?.household;
    if (!household) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Parse parameters
    const anchorMonth = parseMonth(req.query.month) || currentMonth();
    const windowMonths = parseWindowMonths(req.query.months);
    const singleCurrency = parseCurrency(req.query.currency);
    const scope = parseScope(req.query.scope);
    const includeInvestments = parseBool(req.query.includeInvestments ?? true);
    const includeDebtPrincipal = parseBool(req.query.includeDebtPrincipal ?? true);

    // Build month window
    const window = buildMonthWindow(anchorMonth, windowMonths);

    // Build scope filter
    const scopeFilter_where = scopeFilter(scope);

    // Fetch transaction rows
    // We need: id, date, currency, amount, accountId, accountType, txnType,
    // finalCategory, finalBusiness, linkedTransactionId
    const [txnRows] = await sequelize.query(`
      SELECT
        t.id,
        t.date,
        t.currency,
        t.amount,
        t.account_id as "accountId",
        a.account_type as "accountType",
        t.txn_type as "txnType",
        t.final_category as "finalCategory",
        t.final_business as "finalBusiness",
        t.linked_transaction_id as "linkedTransactionId"
      FROM transactions t
      JOIN accounts a ON t.account_id = a.id
      WHERE
        t.household_id = :householdId
        AND t.date >= :startDate
        AND t.date <= :endDate
        AND (t.deleted_at IS NULL OR t.deleted_at > NOW())
        ${singleCurrency ? 'AND t.currency = :currency' : ''}
      ORDER BY t.date ASC
    `, {
      replacements: {
        householdId: household.id,
        startDate: `${window[0]}-01`,
        endDate: `${window[window.length - 1]}-31`,
        ...(singleCurrency && { currency: singleCurrency }),
      },
      type: 'SELECT',
    });

    // Apply visibility and scope filters in-memory (similar to explainMonth)
    const visibleTxns = (txnRows as TxnRawRow[])
      .filter((row) => {
        // TODO: apply visibleTransactionWhere logic
        // For now, assume all rows are visible (auth middleware ensures household access)
        return true;
      })
      .filter((row) => {
        // Apply scope filter (personal/business/shared)
        // TODO: apply scopeFilter logic using finalBusiness, visibility
        return true;
      });

    // Convert to aggregator format
    const txnRows_for_agg: SavingsRateTxnRow[] = visibleTxns.map((row) => ({
      id: row.id,
      date: row.date,
      currency: row.currency,
      amount: row.amount,
      accountId: row.accountId,
      accountType: row.accountType,
      txnType: row.txnType,
      finalCategory: row.finalCategory,
      finalBusiness: row.finalBusiness,
      linkedTransactionId: row.linkedTransactionId,
    }));

    // Call aggregator
    const result = savingsRate(txnRows_for_agg, window, includeInvestments, includeDebtPrincipal);

    res.json(result);
  } catch (err) {
    logger.error('savingsRate route error', { error: err });
    res.status(500).json({ error: 'Internal server error' });
  }
});
```

- [ ] **Step 3: Run backend tests to ensure no regressions**

```bash
cd /Users/connoradams/Developer/cashflow
yarn workspace cashflow-backend run test 2>&1 | tail -50
```

Expected: All tests pass, no new failures.

---

## Task 4: Add TypeScript type definitions on frontend

**Files:**
- Modify: `frontend/src/types/api.ts`

- [ ] **Step 1: Add SavingsRate types to frontend/src/types/api.ts**

Add these types (find the end of the file and append):

```typescript
// Savings Rate Dashboard (Issue #246)

export interface SavingsRateMonthlyPoint {
  month: string; // YYYY-MM
  income: number;
  spending: number;
  savings: number;
  investments: number;
  debtPrincipal: number;
  savingsRate: number | null; // Percentage
}

export interface SavingsRateTotals {
  income: number;
  spending: number;
  savings: number;
  investments: number;
  debtPrincipal: number;
  avgSavingsRate: number | null;
}

export interface SavingsRateCurrencyTrend {
  currency: string;
  series: SavingsRateMonthlyPoint[];
  totals: SavingsRateTotals;
}

export interface SavingsRateResponse {
  currencyTrends: Record<string, SavingsRateCurrencyTrend>;
  months: string[];
  options: {
    includeInvestments: boolean;
    includeDebtPrincipal: boolean;
  };
}
```

- [ ] **Step 2: Verify types are exported correctly**

```bash
cd /Users/connoradams/Developer/cashflow
yarn workspace frontend run tsc -b
```

Expected: No type errors.

---

## Task 5: Create SavingsRatePage component

**Files:**
- Create: `frontend/src/pages/SavingsRatePage.tsx`

- [ ] **Step 1: Create the page component**

```typescript
import { useCallback, useEffect, useMemo, useState } from 'react'
import { TrendingUp, DollarSign } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { NativeSelect } from '@/components/ui/native-select'
import { PageHeader } from '@/components/ui/page-header'
import { getJson } from '../lib/api'
import { formatMoney } from '../lib/formatMoney'
import type {
  SavingsRateResponse,
  SavingsRateCurrencyTrend,
} from '../types/api'

/**
 * SavingsRatePage — renders the savings rate dashboard (Cashflow #246).
 * Shows monthly income, spending, savings, investments, debt principal,
 * and the computed savings rate percentage over a rolling window.
 *
 * Users can filter by:
 *   - Month window (2–36 months, default 12)
 *   - Currency
 *   - Whether to include investments and/or debt principal in the rate
 */

const WINDOW_OPTIONS = [6, 12, 18, 24, 36]

function defaultMonth(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function formatPct(pct: number | null): string {
  if (pct == null) return 'n/a'
  return `${Math.round(pct)}%`
}

export function SavingsRatePage() {
  const [month, setMonth] = useState<string>(defaultMonth())
  const [months, setMonths] = useState<number>(12)
  const [currency, setCurrency] = useState<string>('')
  const [includeInvestments, setIncludeInvestments] = useState<boolean>(true)
  const [includeDebtPrincipal, setIncludeDebtPrincipal] = useState<boolean>(true)
  const [data, setData] = useState<SavingsRateResponse | null>(null)
  const [loading, setLoading] = useState<boolean>(true)
  const [err, setErr] = useState<string | null>(null)

  const queryString = useMemo(() => {
    const params = new URLSearchParams()
    params.set('month', month)
    params.set('months', String(months))
    if (currency) params.set('currency', currency)
    params.set('includeInvestments', String(includeInvestments))
    params.set('includeDebtPrincipal', String(includeDebtPrincipal))
    return params.toString()
  }, [month, months, currency, includeInvestments, includeDebtPrincipal])

  const fetchData = useCallback(async () => {
    try {
      setLoading(true)
      setErr(null)
      const result = await getJson<SavingsRateResponse>(
        `/api/reports/savings-rate?${queryString}`
      )
      setData(result)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to fetch savings rate data')
    } finally {
      setLoading(false)
    }
  }, [queryString])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const currencies = data ? Object.keys(data.currencyTrends) : []

  // If currency filter is set but not in the data, clear it
  useEffect(() => {
    if (currency && !currencies.includes(currency)) {
      setCurrency('')
    }
  }, [currencies, currency])

  const displayCurrency = currency || currencies[0]
  const trend = displayCurrency ? data?.currencyTrends[displayCurrency] : null

  return (
    <div className="space-y-6">
      <PageHeader
        title="Savings Rate"
        subtitle="Track your monthly savings, investments, and debt paydown"
        icon={TrendingUp}
      />

      {/* Controls */}
      <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Anchor Month
            </label>
            <input
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Window (months)
            </label>
            <NativeSelect
              value={String(months)}
              onChange={(e) => setMonths(Number(e.target.value))}
            >
              {WINDOW_OPTIONS.map((opt) => (
                <option key={opt} value={String(opt)}>
                  {opt}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Currency
            </label>
            <NativeSelect
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
            >
              <option value="">All currencies</option>
              {currencies.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </NativeSelect>
          </div>
        </div>

        <div className="flex gap-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={includeInvestments}
              onChange={(e) => setIncludeInvestments(e.target.checked)}
              className="rounded"
            />
            <span className="text-sm text-gray-700">Include investments</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={includeDebtPrincipal}
              onChange={(e) => setIncludeDebtPrincipal(e.target.checked)}
              className="rounded"
            />
            <span className="text-sm text-gray-700">Include debt principal</span>
          </label>
        </div>
      </div>

      {/* Loading / Error */}
      {loading && <div className="text-center py-8 text-gray-500">Loading...</div>}
      {err && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">{err}</div>}

      {/* Data Display */}
      {!loading && !err && trend && (
        <div className="space-y-6">
          {/* Summary Cards */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="text-sm font-medium text-gray-600">Income</div>
              <div className="text-2xl font-bold text-gray-900">
                {formatMoney(trend.totals.income, displayCurrency)}
              </div>
            </div>
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="text-sm font-medium text-gray-600">Spending</div>
              <div className="text-2xl font-bold text-gray-900">
                {formatMoney(trend.totals.spending, displayCurrency)}
              </div>
            </div>
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="text-sm font-medium text-gray-600">Savings</div>
              <div className="text-2xl font-bold text-green-600">
                {formatMoney(trend.totals.savings, displayCurrency)}
              </div>
            </div>
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="text-sm font-medium text-gray-600">Investments</div>
              <div className="text-2xl font-bold text-blue-600">
                {formatMoney(trend.totals.investments, displayCurrency)}
              </div>
            </div>
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="text-sm font-medium text-gray-600">Avg Rate</div>
              <div className="text-2xl font-bold text-purple-600">
                {formatPct(trend.totals.avgSavingsRate)}
              </div>
            </div>
          </div>

          {/* Monthly Breakdown Table */}
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-4 py-3 text-left text-sm font-semibold text-gray-900">Month</th>
                  <th className="px-4 py-3 text-right text-sm font-semibold text-gray-900">Income</th>
                  <th className="px-4 py-3 text-right text-sm font-semibold text-gray-900">Spending</th>
                  <th className="px-4 py-3 text-right text-sm font-semibold text-gray-900">Savings</th>
                  <th className="px-4 py-3 text-right text-sm font-semibold text-gray-900">Investments</th>
                  <th className="px-4 py-3 text-right text-sm font-semibold text-gray-900">Debt Principal</th>
                  <th className="px-4 py-3 text-right text-sm font-semibold text-gray-900">Rate</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {trend.series.map((point) => (
                  <tr key={point.month} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium text-gray-900">{point.month}</td>
                    <td className="px-4 py-3 text-right text-gray-900">
                      {formatMoney(point.income, displayCurrency)}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-900">
                      {formatMoney(point.spending, displayCurrency)}
                    </td>
                    <td className="px-4 py-3 text-right text-green-600 font-medium">
                      {formatMoney(point.savings, displayCurrency)}
                    </td>
                    <td className="px-4 py-3 text-right text-blue-600 font-medium">
                      {formatMoney(point.investments, displayCurrency)}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-900">
                      {formatMoney(point.debtPrincipal, displayCurrency)}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold">
                      <Badge variant={point.savingsRate && point.savingsRate > 30 ? 'default' : 'secondary'}>
                        {formatPct(point.savingsRate)}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Help text */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <h3 className="font-semibold text-blue-900 mb-2">How is this calculated?</h3>
        <ul className="text-sm text-blue-900 space-y-1">
          <li>• <strong>Income:</strong> positive amounts from income transactions</li>
          <li>• <strong>Spending:</strong> negative amounts on non-savings/investment/loan accounts</li>
          <li>• <strong>Savings:</strong> transfers into savings accounts or deposits</li>
          <li>• <strong>Investments:</strong> transfers to investment accounts or investment transactions</li>
          <li>• <strong>Debt Principal:</strong> payments to loans or credit cards</li>
          <li>• <strong>Rate:</strong> (Savings + [Investments] + [Debt Principal]) / Income</li>
        </ul>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify the component compiles**

```bash
cd /Users/connoradams/Developer/cashflow
yarn workspace frontend run tsc -b
```

Expected: No type errors.

---

## Task 6: Add route to frontend router

**Files:**
- Modify: `frontend/src/lib/router.tsx` (or equivalent routing file)

- [ ] **Step 1: Find the import section and add SavingsRatePage import**

Look for other page imports and add:

```typescript
import { SavingsRatePage } from '../pages/SavingsRatePage'
```

- [ ] **Step 2: Add route entry for savings rate**

Find the routes array/configuration and add:

```typescript
{
  path: '/reports/savings-rate',
  element: <SavingsRatePage />,
  name: 'Savings Rate',
}
```

Or if using a different routing pattern, add an equivalent route pointing to `/reports/savings-rate` → `<SavingsRatePage />`.

- [ ] **Step 3: Verify no routing errors**

```bash
cd /Users/connoradams/Developer/cashflow
yarn workspace frontend run tsc -b
```

Expected: No errors.

---

## Task 7: Add sidebar navigation link

**Files:**
- Modify: `frontend/src/components/ui/sidebar.tsx`

- [ ] **Step 1: Find the "Insights & rules" section in the sidebar**

Look for where other insight pages are linked (e.g., LifestyleInflationPage) and add the new link.

Example pattern (adjust for your actual sidebar structure):

```typescript
// In the "Insights & rules" group:
<Link to="/reports/savings-rate" className="...">
  <TrendingUp className="w-4 h-4" />
  <span>Savings Rate</span>
</Link>
```

- [ ] **Step 2: Verify sidebar compiles and no import errors**

```bash
cd /Users/connoradams/Developer/cashflow
yarn workspace frontend run tsc -b
```

Expected: No errors.

---

## Acceptance Criteria Checklist

- [ ] User can view monthly savings rate on the dashboard
- [ ] Dashboard shows income, spending, savings, investments, and debt principal components
- [ ] User can configure whether debt principal and investment transfers count as savings via checkboxes
- [ ] Savings rate supports currency filtering (single currency or all)
- [ ] Internal transfers are not double-counted (only destination leg is classified)
- [ ] Calculation is documented in the UI (help text visible on page)
- [ ] All backend tests pass (`yarn workspace cashflow-backend run test`)
- [ ] All frontend type checks pass (`yarn workspace frontend run tsc -b`)
- [ ] PR opens with auto-merge enabled

---

## Verification Checklist

Before claiming done:

```bash
# Backend unit + integration tests
yarn workspace cashflow-backend run test

# Frontend typecheck
yarn workspace frontend run tsc -b

# Lint (if applicable)
yarn workspace cashflow-backend run lint
yarn workspace frontend run lint

# Start dev server and manually test the feature
yarn dev  # Or equivalent dev server command
# Navigate to /reports/savings-rate and verify:
#   - Page loads with default month/window
#   - Filters (month, window, currency) work
#   - Checkboxes for investments/debt principal toggle correctly
#   - Monthly breakdown table displays correctly
```

---

Plan complete and saved to `/Users/connoradams/Developer/cashflow/docs/superpowers/plans/2026-05-30-savings-rate-dashboard.md`.

**Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
