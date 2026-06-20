import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, } from 'recharts'
import { FilterX, Inbox, ShoppingBag, TrendingUp, Wallet } from 'lucide-react'
import { CategoryIcon } from '../components/CategoryIcon'
import { Link, useNavigate } from 'react-router-dom'
import { Alert } from '@connor-adams/designsystem'
import { Button } from '@connor-adams/designsystem'
import { Card } from '@connor-adams/designsystem'
import { CategoryPill } from '@connor-adams/designsystem'
import { AmountText } from '@connor-adams/designsystem'
import { FilterBar, type QuickRange } from '@/components/ui/filter-bar'
import { PageHeader } from '@/components/ui/page-header'
import { Skeleton, SkeletonText } from '@connor-adams/designsystem'
import { BentoTile, type BentoSpan } from '@/components/dashboard/BentoTile'
import { PeriodInsightBand } from '@/components/dashboard/PeriodInsightBand'
import { KpiStack } from '@/components/dashboard/KpiStack'
import { SplitPanel } from '@/components/dashboard/SplitPanel'
import { TopGrowersTile } from '@/components/dashboard/TopGrowersTile'
import { NetWorthTile } from '@/components/dashboard/NetWorthTile'
import { SafeToSpendTile } from '@/components/dashboard/SafeToSpendTile'
import { RecurringThisMonthTile } from '@/components/dashboard/RecurringThisMonthTile'
import { CurrencyMixTile } from '@/components/dashboard/CurrencyMixTile'
import { ReceiptCoverageTile } from '@/components/dashboard/ReceiptCoverageTile'
import { EmailedReceiptsTile } from '@/components/dashboard/EmailedReceiptsTile'
import { LatestAlertsTile } from '@/components/dashboard/LatestAlertsTile'
import { ImportHealthTile } from '@/components/dashboard/ImportHealthTile'
import { InboxSummaryTile } from '@/components/dashboard/InboxSummaryTile'
import { BudgetStatusCard } from '@/components/dashboard/BudgetStatusCard'
import { ActivationCardDeck } from '@/components/dashboard/ActivationCardDeck'
import { TableTile, type TableTileColumn } from '@/components/dashboard/TableTile'

import { formatCurrency } from '../lib/formatCurrency'
import { DeltaBadge } from '../components/ui/DeltaBadge'
import { rankByNetSpend } from '../lib/rankByNetSpend'
import { businessIncomeSpend } from '../lib/businessIncomeSpend'
import { summaryQueryString } from '../lib/summaryQuery'
import { getJson } from '../lib/api'
import {
  fromDateInputValue,
  getCalendarMonthRange,
  getCalendarQuarterRange,
  getCalendarYearRange,
  toDateInputValue,
  todayDateInputValue,
} from '../lib/dateInput'
import { useSessionState } from '../lib/useSessionState'
import {
  formatCompactMoney,
  formatShortMonth,
  useIsNarrowViewport,
} from '../lib/chartViewport'
import type {
  BudgetProgress,
  BudgetProgressResponse,
  RecurringItem,
  RecurringResponse,
  RollupRow,
} from '../types/api'
import type { PeriodInsightResp, PeriodInsightCurrency } from '@cashflow/shared'
import { DashboardCategorySection } from './DashboardCategorySection'

type Row = {
  currency: string
  category: string | null
  sumAmount: number
  finalBusiness: boolean
  finalSplitType: string
}

type CurrencyMetrics = {
  currency: string
  totalSpend: number
  totalCredits: number
  totalPayments: number
  totalIncome: number
  netSpend: number
  transactionCount: number
}

type MonthlyCurrencyBreakdown = {
  month: string
  currency: string
  totalSpend: number
  totalCredits: number
  totalPayments: number
  totalIncome: number
  netSpend: number
}

type BusinessReportRow = {
  currency: string
  business: boolean
  totalSpend: number
  totalCredits: number
  netSpend: number
  income: number
}

type CategoryReportRow = {
  currency: string
  category: string | null
  totalSpend: number
  totalCredits: number
  netSpend: number
}

type MerchantSummaryRow = {
  currency: string
  merchant: string
  totalSpend: number
  totalCredits: number
  totalPayments: number
  netSpend: number
  transactionCount: number
  lastDate: string
  reviewCount: number
}

type AccountSummaryRow = {
  currency: string
  accountId: number
  accountName: string
  accountShortCode: string | null
  totalSpend: number
  totalCredits: number
  totalPayments: number
  netSpend: number
  transactionCount: number
  reviewCount: number
}

type ReviewQueueRow = {
  id: number
  date: string
  currency: string
  merchant: string
  accountName: string
  category: string | null
  amount: number
}

type DashResp = {
  byCategory: Row[]
  metricsByCurrency: CurrencyMetrics[]
  monthlyByCurrency: MonthlyCurrencyBreakdown[]
  netSpendByBusiness: BusinessReportRow[]
  categoryReports: CategoryReportRow[]
  merchantSummaries: MerchantSummaryRow[]
  accountSummaries: AccountSummaryRow[]
  reviewQueue: ReviewQueueRow[]
  categoryTree?: RollupRow[]
}

type MonthlyResp = {
  points: { month: string; currency: string; sumAmount: number }[]
}


// Ordinal palette for the multi-currency line chart. Each entry resolves
// against the active theme (Honey & Ink dual-mode tokens in index.css).
const LINE_COLORS = [
  'var(--chart-line-1)',  // amber
  'var(--chart-line-2)',  // jade
  'var(--chart-line-3)',  // plum
  'var(--chart-line-4)',  // rust
  'var(--chart-line-5)',  // steel
  'var(--chart-line-6)',  // mauve
]
const DEFAULT_DASHBOARD_CURRENCY = 'CAD'
const CHART_TOOLTIP_STYLE = {
  backgroundColor: 'var(--popover)',
  border: '1px solid var(--border)',
  borderRadius: '14px',
  boxShadow: 'var(--shadow)',
  color: 'var(--popover-foreground)',
}
const CHART_TOOLTIP_LABEL_STYLE = {
  color: 'var(--popover-foreground)',
  fontWeight: 600,
  marginBottom: '0.35rem',
}
const CHART_TOOLTIP_ITEM_STYLE = {
  color: 'var(--popover-foreground)',
  padding: 0,
}
// Cursor highlight rendered behind the focused datum on hover. The default is
// near-white which becomes invisible on a white card in light mode.
const CHART_TOOLTIP_CURSOR = {
  fill: 'color-mix(in oklch, var(--accent) 30%, transparent)',
}

function getPreviousRange(
  dateFrom: string,
  dateTo: string
): { from: string; to: string } | null {
  const from = fromDateInputValue(dateFrom)
  const to = fromDateInputValue(dateTo)
  if (!from || !to || from > to) return null
  const dayMs = 24 * 60 * 60 * 1000
  const spanDays = Math.floor((to.getTime() - from.getTime()) / dayMs) + 1
  const prevTo = new Date(from.getTime() - dayMs)
  const prevFrom = new Date(prevTo.getTime() - (spanDays - 1) * dayMs)
  return { from: toDateInputValue(prevFrom), to: toDateInputValue(prevTo) }
}

/**
 * Anchor for default-range calculations: UTC midnight of the user's local
 * calendar day. Routing all default-range math through this anchor keeps the
 * derived YYYY-MM-DD strings stable regardless of the user's timezone.
 */
function localTodayUtcMidnight(): Date {
  return fromDateInputValue(todayDateInputValue())!
}

function getDefaultDashboardRange(): { from: string; to: string } {
  return getCalendarMonthRange(0)
}

function getRollingMonthRange(months: number): { from: string; to: string } {
  const to = localTodayUtcMidnight()
  const from = new Date(to)
  from.setUTCMonth(from.getUTCMonth() - months)
  return { from: toDateInputValue(from), to: toDateInputValue(to) }
}

function getYearToDateRange(): { from: string; to: string } {
  const to = localTodayUtcMidnight()
  const from = new Date(Date.UTC(to.getUTCFullYear(), 0, 1))
  return { from: toDateInputValue(from), to: toDateInputValue(to) }
}

/**
 * Fetch /api/recurring with the given currency filter. Returns the items
 * on success or an empty list on failure — never throws. Pulled out so
 * the useEffect that uses it stays small enough for the complexity gate.
 */
async function fetchRecurringSafely(currency: string): Promise<RecurringItem[]> {
  const qs = currency ? `?currency=${encodeURIComponent(currency)}` : ''
  try {
    const resp = await getJson<RecurringResponse>(`/api/recurring${qs}`)
    return resp.items
  } catch {
    return []
  }
}

/**
 * Build a `/transactions?…` URL with the dashboard's current
 * filter context layered on top of the caller's extra params.
 * Dedupes the bento drill-click handlers (top categories chart,
 * top merchants, top accounts) which all preserve the same context.
 */
function transactionsUrl(
  extra: Record<string, string>,
  ctx: { currency: string; dateFrom: string; dateTo: string }
): string {
  const qs = new URLSearchParams(extra)
  if (ctx.currency) qs.set('currency', ctx.currency)
  if (ctx.dateFrom) qs.set('dateFrom', ctx.dateFrom)
  if (ctx.dateTo) qs.set('dateTo', ctx.dateTo)
  return `/transactions?${qs.toString()}`
}

export function DashboardPage() {
  const navigate = useNavigate()
  const isNarrowViewport = useIsNarrowViewport()
  const defaultRange = useMemo(() => getDefaultDashboardRange(), [])
  const [currency, setCurrency] = useSessionState<string>(
    'dashboard.currency',
    DEFAULT_DASHBOARD_CURRENCY
  )
  const [dateFrom, setDateFrom] = useSessionState<string>(
    'dashboard.dateFrom',
    () => defaultRange.from
  )
  const [dateTo, setDateTo] = useSessionState<string>(
    'dashboard.dateTo',
    () => defaultRange.to
  )
  const [data, setData] = useState<DashResp | null>(null)
  const [previousMetricsByCurrency, setPreviousMetricsByCurrency] = useState<
    CurrencyMetrics[]
  >([])
  // Previous-period category rollups, used by the Top growers tile. The
  // /api/summary/dashboard response already includes categoryReports for
  // the previous-period fetch; before this it was discarded.
  const [previousCategoryReports, setPreviousCategoryReports] = useState<
    CategoryReportRow[]
  >([])
  const [monthly, setMonthly] = useState<MonthlyResp | null>(null)
  const [insight, setInsight] = useState<PeriodInsightResp | null>(null)
  const [budgetProgress, setBudgetProgress] = useState<BudgetProgress[]>([])
  // Recurring charges, fetched separately so a /api/recurring failure
  // never tanks the rest of the dashboard. Empty list on failure or
  // initial load.
  const [recurringItems, setRecurringItems] = useState<RecurringItem[]>([])
  const [recurringLoading, setRecurringLoading] = useState(true)
  const [priceChangeCount, setPriceChangeCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  // Banner dismissals persist for the browser session, keyed to the count the
  // user dismissed at. If the underlying count later changes (new flags, new
  // price changes), the banner re-surfaces because the stored count no longer
  // matches — a dismiss silences the *current* situation, not future ones.
  const [reviewDismissedAt, setReviewDismissedAt] = useSessionState<number | null>(
    'dashboard.reviewBannerDismissedAt',
    null
  )
  const [priceDismissedAt, setPriceDismissedAt] = useSessionState<number | null>(
    'dashboard.priceBannerDismissedAt',
    null
  )

  const summaryQs = useMemo(
    () => summaryQueryString({ currency, dateFrom, dateTo }),
    [currency, dateFrom, dateTo]
  )
  const previousRange = useMemo(
    () => getPreviousRange(dateFrom, dateTo),
    [dateFrom, dateTo]
  )

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setErr(null)
      try {
        const [d, m, prev, pi] = await Promise.all([
          getJson<DashResp>(`/api/summary/dashboard${summaryQs}`),
          getJson<MonthlyResp>(`/api/summary/monthly${summaryQs}`),
          previousRange
            ? getJson<DashResp>(
                `/api/summary/dashboard${summaryQueryString({
                  currency,
                  dateFrom: previousRange.from,
                  dateTo: previousRange.to,
                })}`
              )
            : Promise.resolve<DashResp | null>(null),
          // Only fetch the period insight when both bounds are set — the band
          // needs a bounded range to detect range-kind and baselines.
          dateFrom && dateTo
            ? getJson<PeriodInsightResp>(
                `/api/summary/period-insight${summaryQs}`
              )
            : Promise.resolve<PeriodInsightResp | null>(null),
        ])
        if (!cancelled) {
          setData(d)
          setMonthly(m)
          setPreviousMetricsByCurrency(prev?.metricsByCurrency ?? [])
          setPreviousCategoryReports(prev?.categoryReports ?? [])
          setInsight(pi)
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : 'Error')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [summaryQs, previousRange, currency, dateFrom, dateTo])

  // Budget progress is scoped to the active currency filter only — periods
  // are always "current calendar month" on the backend, so date filters
  // don't apply. Kept in its own effect so a failing /budgets/progress
  // request doesn't tank the main dashboard rendering.
  useEffect(() => {
    let cancelled = false
    const qs = currency
      ? `?currency=${encodeURIComponent(currency)}`
      : ''
    ;(async () => {
      try {
        const resp = await getJson<BudgetProgressResponse>(
          `/api/budgets/progress${qs}`
        )
        if (!cancelled) setBudgetProgress(resp.items)
      } catch {
        if (!cancelled) setBudgetProgress([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [currency])

  // Sort most-at-risk first; ties broken by category label so layout is
  // deterministic between renders. Overall budgets ("null" category) get a
  // stable label for the sort comparator.
  const budgetProgressSorted = useMemo(() => {
    return [...budgetProgress].sort((a, b) => {
      if (b.percentUsed !== a.percentUsed) return b.percentUsed - a.percentUsed
      return (a.category ?? '').localeCompare(b.category ?? '')
    })
  }, [budgetProgress])

  // Recurring charges, fetched separately on currency change. Wrapped in
  // try/catch so a failed fetch falls back to empty (same pattern as
  // budgets above) — the Recurring tile self-handles empty/error states.
  useEffect(() => {
    let cancelled = false
    setRecurringLoading(true)
    void fetchRecurringSafely(currency).then((items) => {
      if (cancelled) return
      setRecurringItems(items)
      setRecurringLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [currency])

  useEffect(() => {
    // Price increases are now subscription_price_increase Insights; count the
    // open ones. GET /api/insights returns { data: [...] }.
    void getJson<{ data: unknown[] }>(
      '/api/insights?type=subscription_price_increase&status=open',
    )
      .then((res) => setPriceChangeCount(res.data.length))
      .catch(() => setPriceChangeCount(0))
  }, [])

  const currencies = useMemo(() => {
    const s = new Set<string>()
    data?.byCategory.forEach((r) => s.add(r.currency))
    data?.metricsByCurrency.forEach((r) => s.add(r.currency))
    monthly?.points.forEach((p) => s.add(p.currency))
    return Array.from(s).sort()
  }, [data, monthly])

  const chartData = useMemo(() => {
    const byCat = new Map<string, number>()
    for (const r of data?.byCategory ?? []) {
      if (currency && r.currency !== currency) continue
      const raw = (r.category ?? '').trim().toLowerCase()
      if (raw === 'investments') continue
      const label =
        raw === '' || raw === 'uncategorized'
          ? '(uncategorized)'
          : r.category!
      byCat.set(label, (byCat.get(label) ?? 0) + r.sumAmount)
    }
    // Flip sign so spend reads as positive money-out. Charges land in the DB
    // as negative; refunds/credits as positive. After negation a typical
    // spend category shows a positive bar (going right), and a category that
    // net-refunded shows a negative bar (going left) which reads as
    // "money came back from this category".
    // Sort descending by absolute value so the biggest spenders are at the top.
    return Array.from(byCat.entries())
      .map(([name, total]) => ({ name, total: -total }))
      .sort((a, b) => Math.abs(b.total) - Math.abs(a.total))
  }, [data, currency])

  // Drill from a category bar into a pre-filtered Transactions view. Preserves
  // the active currency and date filters so the destination opens with the
  // same slice the chart was showing. Uses the literal '(uncategorized)'
  // sentinel for null categories; Transactions filters on exact category
  // string, so this acts as a visible chip the user can clear.
  const navigateToCategory = useCallback(
    (categoryName: string) => {
      if (!categoryName) return
      navigate(
        transactionsUrl(
          { category: categoryName },
          { currency, dateFrom, dateTo }
        )
      )
    },
    [navigate, currency, dateFrom, dateTo]
  )

  const monthlyLineKeys = useMemo(() => {
    const s = new Set<string>()
    for (const p of monthly?.points ?? []) s.add(p.currency)
    return Array.from(s).sort()
  }, [monthly])

  const monthlyChartData = useMemo(() => {
    const pts = monthly?.points ?? []
    const months = [...new Set(pts.map((p) => p.month))].sort()
    const lookup = new Map<string, Map<string, number>>()
    for (const p of pts) {
      if (!lookup.has(p.month)) lookup.set(p.month, new Map())
      lookup.get(p.month)!.set(p.currency, p.sumAmount)
    }
    return months.map((month) => {
      // null (vs 0) so Recharts treats missing (month, currency) pairs as
      // gaps rather than "$0 spent" — paired with connectNulls={false} on
      // the Line element below.
      const row: Record<string, string | number | null> = { month }
      for (const c of monthlyLineKeys) {
        row[c] = lookup.get(month)?.get(c) ?? null
      }
      return row
    })
  }, [monthly, monthlyLineKeys])

  const monthlyBreakdownData = useMemo(() => {
    const rows = data?.monthlyByCurrency ?? []
    const byMonth = new Map<
      string,
      {
        month: string
        totalSpend: number
        totalCredits: number
        totalPayments: number
        netSpend: number
      }
    >()
    for (const row of rows) {
      if (currency && row.currency !== currency) continue
      const existing = byMonth.get(row.month) ?? {
        month: row.month,
        totalSpend: 0,
        totalCredits: 0,
        totalPayments: 0,
        netSpend: 0,
      }
      existing.totalSpend += row.totalSpend
      existing.totalCredits += row.totalCredits
      existing.totalPayments += row.totalPayments
      existing.netSpend += row.netSpend
      byMonth.set(row.month, existing)
    }
    return Array.from(byMonth.values()).sort((a, b) => a.month.localeCompare(b.month))
  }, [data?.monthlyByCurrency, currency])

  const bizSplit = useMemo(
    () => businessIncomeSpend(data?.netSpendByBusiness ?? [], currency),
    [data?.netSpendByBusiness, currency]
  )

  const merchantReportData = useMemo(
    () => rankByNetSpend(data?.merchantSummaries ?? [], currency),
    [data?.merchantSummaries, currency]
  )

  const accountReportData = useMemo(
    () => rankByNetSpend(data?.accountSummaries ?? [], currency),
    [data?.accountSummaries, currency]
  )

  const reviewQueueData = useMemo(() => {
    const rows = data?.reviewQueue ?? []
    return rows
      .filter((row) => !currency || row.currency === currency)
      .slice()
      .sort((a, b) =>
        a.date === b.date ? Math.abs(b.amount) - Math.abs(a.amount) : b.date.localeCompare(a.date)
      )
  }, [data?.reviewQueue, currency])

  const summaryStats = useMemo(() => {
    const metricRows = data?.metricsByCurrency ?? []
    const selected = metricRows.filter((r) => !currency || r.currency === currency)
    const prevSelected = previousMetricsByCurrency.filter(
      (r) => !currency || r.currency === currency
    )
    const txCount = selected.reduce((sum, row) => sum + row.transactionCount, 0)
    const prevTxCount = prevSelected.reduce((sum, row) => sum + row.transactionCount, 0)
    const txDelta = txCount - prevTxCount
    return {
      txCount,
      txDelta,
      merchantCount: merchantReportData.length,
      accountCount: accountReportData.length,
      reviewCount: reviewQueueData.length,
    }
  }, [
    data?.metricsByCurrency,
    previousMetricsByCurrency,
    currency,
    merchantReportData.length,
    accountReportData.length,
    reviewQueueData.length,
  ])

  // Resolve the period-insight entry matching the selected currency. With no
  // currency filter, fall back to the first currency (multi-currency full
  // breakdown is a follow-up).
  const insightForCurrency: PeriodInsightCurrency | null = useMemo(() => {
    if (!insight) return null
    if (currency) return insight.byCurrency.find((c) => c.currency === currency) ?? null
    return insight.byCurrency[0] ?? null
  }, [insight, currency])

  const activeRangeLabel = useMemo(() => {
    if (!dateFrom && !dateTo) return 'All dates'
    if (dateFrom && dateTo) return `${dateFrom} to ${dateTo}`
    if (dateFrom) return `From ${dateFrom}`
    return `Up to ${dateTo}`
  }, [dateFrom, dateTo])

  const quickRanges = useMemo<QuickRange[]>(
    () => [
      { key: 'month', label: 'This month', ...getCalendarMonthRange(0) },
      { key: 'lastMonth', label: 'Last month', ...getCalendarMonthRange(-1) },
      { key: 'quarter', label: 'This quarter', ...getCalendarQuarterRange(0) },
      {
        key: 'lastQuarter',
        label: 'Last quarter',
        ...getCalendarQuarterRange(-1),
      },
      { key: 'year', label: 'This year', ...getCalendarYearRange(0) },
      { key: 'lastYear', label: 'Last year', ...getCalendarYearRange(-1) },
      { key: '3m', label: '3 months', ...getRollingMonthRange(3) },
      { key: '6m', label: '6 months', ...getRollingMonthRange(6) },
      { key: 'ytd', label: 'YTD', ...getYearToDateRange() },
      { key: 'all', label: 'All time', from: '', to: '' },
    ],
    []
  )

  const hasActiveFilters =
    currency !== DEFAULT_DASHBOARD_CURRENCY ||
    dateFrom !== defaultRange.from ||
    dateTo !== defaultRange.to

  // True only when a real previous window exists. `getPreviousRange` returns
  // null whenever either bound is missing or the range is empty, so this
  // tracks the actual fetch outcome rather than re-deriving from raw inputs.
  // Single-bound filters (only dateFrom or only dateTo) previously slipped
  // through `Boolean(dateFrom || dateTo)` and rendered fabricated deltas
  // against $0 prior-period totals.
  const hasComparisonPeriod = Boolean(previousRange)

  const displayCurrency = currency || (currencies.length === 1 ? currencies[0] : '')
  const formatDashboardAmount = (value: number): string =>
    displayCurrency
      ? formatCurrency(value, displayCurrency)
      : new Intl.NumberFormat(undefined, {
          maximumFractionDigits: 2,
        }).format(value)
  // Narrow-viewport chart configuration. Pulled out so each chart references
  // the same defaults; charts override individually where they need to.
  // - tick font shrinks 12 -> 11
  // - chart margins collapse so bars actually fill the card width
  // - legends move below or hide when a single dataKey makes them redundant
  // - currency axis ticks use compact notation ("$1.2k") to avoid overlap
  // - month axis ticks render "Jan" instead of "2025-01" and drop interior
  //   labels when there are many months
  const narrowAxisTick = isNarrowViewport
    ? { fontSize: 11 }
    : undefined
  const narrowChartMargin = isNarrowViewport
    ? { top: 8, right: 4, bottom: 0, left: 0 }
    : undefined
  const compactCurrencyTickFormatter = (value: number | string): string => {
    const v = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(v)) return ''
    return isNarrowViewport
      ? formatCompactMoney(v, displayCurrency || null)
      : new Intl.NumberFormat(undefined, {
          maximumFractionDigits: 0,
        }).format(v)
  }
  // Always render "Jan", "Feb", … on the month axis — handing Recharts the raw
  // "2025-01" string causes label fragmentation once there are ~12+ months in
  // the chart (Recharts truncates and renders partial year prefixes).
  const monthTickFormatter = (value: string | number): string => {
    if (typeof value !== 'string') return String(value)
    return formatShortMonth(value)
  }

  // Column specs for the bento table-tiles.
  const merchantColumns: TableTileColumn<MerchantSummaryRow>[] = [
    { key: 'merchant', label: 'Merchant', render: (r) => r.merchant },
    {
      key: 'txns',
      label: 'Txns',
      align: 'right',
      width: '3rem',
      render: (r) => r.transactionCount,
    },
    {
      key: 'net',
      label: 'Net spend',
      align: 'right',
      render: (r) => formatCurrency(r.netSpend, r.currency),
    },
  ]

  const accountColumns: TableTileColumn<AccountSummaryRow>[] = [
    {
      key: 'account',
      label: 'Account',
      render: (r) => r.accountShortCode ?? r.accountName,
    },
    {
      key: 'txns',
      label: 'Txns',
      align: 'right',
      width: '3rem',
      render: (r) => r.transactionCount,
    },
    {
      key: 'net',
      label: 'Net spend',
      align: 'right',
      render: (r) => formatCurrency(r.netSpend, r.currency),
    },
  ]

  const reviewColumns: TableTileColumn<ReviewQueueRow>[] = [
    { key: 'date', label: 'Date', width: '6rem', render: (r) => r.date },
    { key: 'merchant', label: 'Merchant', render: (r) => r.merchant },
    { key: 'account', label: 'Account', render: (r) => r.accountName },
    {
      key: 'category',
      label: 'Category',
      render: (r) => (
        <span className="inline-flex items-center gap-1.5">
          <CategoryIcon name={r.category} />
          {r.category ?? '(uncategorized)'}
        </span>
      ),
    },
    {
      key: 'amount',
      label: 'Amount',
      align: 'right',
      width: '6rem',
      render: (r) => formatCurrency(r.amount, r.currency),
    },
  ]

  // Review banner pins to 8 cols so it lines up with the period insight band
  // beneath it instead of sprawling full-width across an empty middle.
  // Hidden once dismissed at the current count (see reviewDismissedAt above).
  const showReviewBanner =
    summaryStats.reviewCount > 0 &&
    reviewDismissedAt !== summaryStats.reviewCount
  const reviewBannerSpan: BentoSpan = 12
  const showPriceBanner =
    priceChangeCount > 0 && priceDismissedAt !== priceChangeCount

  return (
    <div className="page">
      <PageHeader
        title="Dashboard"
        description="Totals stay in each currency. Filter by currency and date range."
      />
      {err && <Alert variant="error">{err}</Alert>}

      <Card className="mb-4 mt-2 w-fit max-w-full p-2 sm:p-3" style={{ padding: undefined }}>
          <FilterBar
            className="gap-2"
            currency={currency}
            onCurrencyChange={setCurrency}
            availableCurrencies={currencies}
            allCurrenciesLabel="All (category chart may mix currencies)"
            dateFrom={dateFrom}
            dateTo={dateTo}
            onDateChange={(from, to) => {
              setDateFrom(from)
              setDateTo(to)
            }}
            quickRanges={quickRanges}
            quickRangesLabel="Quick date ranges"
            actions={
              hasActiveFilters ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setCurrency(DEFAULT_DASHBOARD_CURRENCY)
                    setDateFrom(defaultRange.from)
                    setDateTo(defaultRange.to)
                  }}
                >
                  <FilterX aria-hidden="true" />
                  Clear filters
                </Button>
              ) : null
            }
            caption={
              <p className="mb-0 flex items-center flex-wrap gap-[0.4rem] text-sm leading-6 text-muted-foreground">
                Showing
                {/* Pill-style active-filter chip — reads as the currently
                    applied scope rather than a low-contrast footnote. Uses
                    --muted as the surface and --border for the outline to stay
                    on the brand token palette (no hex). */}
                <span className="inline-flex items-center gap-[0.35rem] px-[0.65rem] py-1 rounded-full border border-border bg-muted text-foreground text-[0.8rem] leading-[1.2]">
                  <strong>{currency || 'all currencies'}</strong>
                  <span className="text-muted-foreground">·</span>
                  <strong>{activeRangeLabel}</strong>
                </span>
              </p>
            }
          />
      </Card>

      <ActivationCardDeck />

      {loading ? (
        <div
          className="mb-4 grid grid-flow-row-dense grid-cols-1 sm:grid-cols-6 lg:grid-cols-12 gap-4 auto-rows-[minmax(160px,auto)]"
          aria-busy={loading}
          aria-label="Loading dashboard"
        >
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={`dash-skeleton-stat-${i}`}
              className="col-span-1 sm:col-span-3 lg:col-span-2 rounded-xl border border-border bg-card p-4"
            >
              <Skeleton className="h-3 w-1/2" />
              <Skeleton className="mt-3 h-7 w-2/3" />
              <Skeleton className="mt-2 h-3 w-1/3" />
            </div>
          ))}
          <div className="col-span-1 sm:col-span-6 lg:col-span-8 row-span-2 flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="min-h-[14rem] flex-1 rounded-lg" />
          </div>
          <div className="col-span-1 sm:col-span-6 lg:col-span-4 row-span-2 flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
            <Skeleton className="h-4 w-1/2" />
            <SkeletonText lines={6} />
          </div>
          {Array.from({ length: 2 }).map((_, i) => (
            <div
              key={`dash-skeleton-tile-${i}`}
              className="col-span-1 sm:col-span-3 lg:col-span-6 row-span-2 flex flex-col gap-3 rounded-xl border border-border bg-card p-4"
            >
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="min-h-[10rem] flex-1 rounded-lg" />
            </div>
          ))}
        </div>
      ) : (
      <div
        className="mb-4 grid grid-flow-row-dense grid-cols-1 sm:grid-cols-6 lg:grid-cols-12 gap-4 auto-rows-[minmax(160px,auto)]"
        aria-busy={loading}
      >
        <SafeToSpendTile currency={currency || null} />

        {showReviewBanner && (
          <BentoTile
            span={reviewBannerSpan}
            rows={1}
            variant="warning"
            role="status"
            aria-live="polite"
            icon={<Inbox className="size-5" />}
            label={`${summaryStats.reviewCount} transaction${
              summaryStats.reviewCount === 1 ? '' : 's'
            } flagged for review`}
            description="Waiting on category, split, or business decisions before they roll into your totals."
            actions={<Link to="/review"><Button size="sm">Open Review Inbox</Button></Link>}
            onDismiss={() => setReviewDismissedAt(summaryStats.reviewCount)}
            dismissLabel="Dismiss review reminder"
          />
        )}
        {showPriceBanner && (
          <BentoTile
            span={12}
            rows={1}
            variant="destructive"
            role="status"
            aria-live="polite"
            icon={<TrendingUp className="size-5" />}
            label={`${priceChangeCount} subscription price change${priceChangeCount === 1 ? '' : 's'} this month`}
            actions={<Link to="/subscriptions?priceChange=unack"><Button size="sm" variant="outline">Review</Button></Link>}
            onDismiss={() => setPriceDismissedAt(priceChangeCount)}
            dismissLabel="Dismiss subscription price alert"
          />
        )}
        {budgetProgressSorted.length > 0 && (
          <BentoTile
            span={12}
            rows={1}
            aria-busy={loading}
            label="Budget progress + pacing"
            description="Spend so far against each budget plus how much of the period has elapsed. Tick on the bar = where you'd be if perfectly paced."
          >
            {/* formerly .budgetPillStrip */}
            <div className="flex h-full gap-3 overflow-x-auto pb-1 [scrollbar-width:thin]">
              {budgetProgressSorted.map((item) => {
                // Tone prefers the backend's pacingState classification
                // when available — it already accounts for time-elapsed,
                // so 'ahead' surfaces the "88% spent, 62% of month done"
                // headline. We fall back to the old percentUsed thresholds
                // so existing tests / pre-status payloads still render
                // sensibly.
                const tone: 'ok' | 'warn' | 'over' = item.pacingState
                  ? item.pacingState === 'over'
                    ? 'over'
                    : item.pacingState === 'ahead'
                      ? 'warn'
                      : 'ok'
                  : item.percentUsed > 100
                    ? 'over'
                    : item.percentUsed >= 80
                      ? 'warn'
                      : 'ok'
                const width = `${Math.min(100, item.percentUsed)}%`
                const elapsedTick =
                  typeof item.periodElapsedPercent === 'number'
                    ? `${Math.min(100, Math.max(0, item.periodElapsedPercent))}%`
                    : null
                const label = item.category ?? 'Overall'
                const percentRounded = Math.round(item.percentUsed)
                const elapsedRounded =
                  typeof item.periodElapsedPercent === 'number'
                    ? Math.round(item.periodElapsedPercent)
                    : null
                const periodWord =
                  item.period === 'weekly'
                    ? 'week'
                    : item.period === 'annual'
                      ? 'year'
                      : 'month'
                // Lookup table for JIT-safe Tailwind class names. The state
                // string comes from server data so we cannot template the
                // class with interpolation — Tailwind won't pick it up.
                const pacingBadgeClass: Record<string, string> = {
                  'on-pace':
                    'bg-success-bg text-success-foreground',
                  ahead:
                    'bg-warning-bg text-warning-foreground',
                  behind:
                    'bg-info-bg text-info-foreground',
                  over:
                    'bg-danger-bg text-danger',
                }
                const pacingLabel: Record<string, string> = {
                  'on-pace': 'On pace',
                  ahead: 'Ahead of pace',
                  behind: 'Under pace',
                  over: 'Over budget',
                }
                // Lookup table for the fill background color keyed on tone.
                // Cannot interpolate class names — Tailwind JIT needs literals.
                const fillBgStyle: Record<'ok' | 'warn' | 'over', string> = {
                  ok: 'var(--positive)',
                  warn: 'var(--primary)',
                  over: 'var(--destructive)',
                }
                return (
                  // formerly .budgetPill + .budgetPill--{tone}
                  // color-mix background must be inline (no JIT equivalent)
                  <article
                    key={item.budgetId}
                    className="flex shrink-0 flex-col justify-center gap-1.5 rounded-md border border-border p-2.5"
                    // color-mix background has no Tailwind utility — keep inline var().
                    style={{
                      background: 'color-mix(in oklch, var(--muted) 50%, transparent)',
                      minWidth: '200px',
                      maxWidth: '240px',
                    }}
                  >
                    {/* formerly .budgetPill__header */}
                    <header className="flex items-baseline justify-between gap-2">
                      {/* formerly .budgetPill__label */}
                      <strong className="truncate text-sm font-semibold text-foreground inline-flex items-center gap-1.5 min-w-0" title={label}>
                        <CategoryIcon name={item.category} />
                        <span className="truncate">{label}</span>
                      </strong>
                      {/* formerly .budgetPill__pct */}
                      <span className="shrink-0 text-xs font-semibold tabular-nums text-muted-foreground">{percentRounded}%</span>
                    </header>
                    {/* formerly .budgetPill__bar — color-mix bg must stay inline */}
                    <div
                      className="relative h-1.5 w-full overflow-hidden rounded-full border border-border bg-muted"
                      role="img"
                      aria-label={
                        elapsedRounded !== null
                          ? `${label}: ${percentRounded} percent of ${periodWord}'s budget used; ${elapsedRounded} percent of the ${periodWord} has elapsed.`
                          : `${label} ${percentRounded} percent of target used`
                      }
                    >
                      {/* formerly .budgetPill__fill + .budgetPill--{tone} .budgetPill__fill */}
                      <span
                        className="block h-full"
                        style={{
                          background: fillBgStyle[tone],
                          transition: 'width 0.3s ease-out',
                          width,
                        }}
                      />
                      {elapsedTick !== null && (
                        // Vertical tick indicating where spend "should" be
                        // if the user were perfectly on-pace. Helps the eye
                        // compare the filled bar's right edge to where the
                        // period clock is at.
                        <span
                          className="absolute top-0 bottom-0 w-px bg-foreground/60"
                          style={{ left: elapsedTick }}
                          aria-hidden="true"
                        />
                      )}
                    </div>
                    {/* formerly .budgetPill__amount */}
                    <p className="m-0 truncate text-xs text-muted-foreground">
                      {formatCurrency(item.spent, item.currency)} /{' '}
                      {formatCurrency(item.target, item.currency)}{' '}
                      {/* formerly .budgetPill__currency */}
                      <span className="ml-1 opacity-70">{item.currency}</span>
                    </p>
                    {item.pacingState && elapsedRounded !== null && (
                      <p className="mt-1">
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                            pacingBadgeClass[item.pacingState] ?? ''
                          }`}
                        >
                          {pacingLabel[item.pacingState] ?? item.pacingState}
                          <span className="ml-1 opacity-75">
                            ({percentRounded}% spent / {elapsedRounded}%{' '}
                            {periodWord})
                          </span>
                        </span>
                      </p>
                    )}
                  </article>
                )
              })}
            </div>
          </BentoTile>
        )}

        {/* Status-pill card (issue #268). Sits alongside the pacing tile —
            pacing reflects time-elapsed; status reflects the same 80/100
            thresholds the daily breach-check cron uses, so what the user
            sees here matches what they'd be alerted about. */}
        <BudgetStatusCard currency={currency || 'CAD'} />

        <BentoTile
          span={12}
          rows={2}
          variant="hero"
          aria-busy={loading}
          aria-label="This period at a glance"
        >
          {insightForCurrency ? (
            <PeriodInsightBand
              data={insightForCurrency}
              currency={currency}
              rangeLabel={
                quickRanges.find(
                  (q) => q.from === dateFrom && q.to === dateTo,
                )?.label
              }
            />
          ) : (
            <div className="text-sm text-muted-foreground">
              Pick a start and end date to see the period breakdown.
            </div>
          )}
        </BentoTile>

        <BentoTile span={6} rows={2} aria-busy={loading} aria-label="Activity counts">
          <KpiStack
            items={[
              {
                label: 'Transactions',
                value: summaryStats.txCount,
                hint: 'Rows in current filters',
                delta: hasComparisonPeriod ? (
                  <DeltaBadge delta={summaryStats.txDelta} metricKind="neutral" />
                ) : undefined,
              },
              {
                label: 'Merchants',
                value: summaryStats.merchantCount,
                hint: 'Distinct merchants',
              },
              {
                label: 'Accounts',
                value: summaryStats.accountCount,
                hint: 'With activity in period',
              },
            ]}
          />
        </BentoTile>

        <NetWorthTile />

        <InboxSummaryTile />

        <BentoTile
          span={6}
          rows={2}
          aria-busy={loading}
          icon={<Wallet className="size-5" />}
          label="Income · business vs personal"
          description="Earned income split by business vs personal."
        >
          <SplitPanel
            business={bizSplit.income.business}
            personal={bizSplit.income.personal}
            businessShare={bizSplit.incomeShare}
            currency={displayCurrency}
            emptyCaption="No income in current filters."
          />
        </BentoTile>

        <BentoTile
          span={6}
          rows={2}
          aria-busy={loading}
          icon={<ShoppingBag className="size-5" />}
          label="Spend · business vs personal"
          description="Spend (gross outflows net of refunds) split by business vs personal."
        >
          <SplitPanel
            business={bizSplit.spend.business}
            personal={bizSplit.spend.personal}
            businessShare={bizSplit.spendShare}
            currency={displayCurrency}
            emptyCaption="No net spend in current filters."
          />
        </BentoTile>

        <BentoTile
          span={12}
          rows={1}
          aria-busy={loading}
          label="Net spend by category"
          description="Click a bar to open those transactions with the current filters applied. Payments and transfers are excluded."
        >
          {chartData.length === 0 ? (
            !loading ? (
              <div>
                <p className="m-0 text-muted-foreground">
                  No category totals for these filters. Your transactions may be in a
                  different currency or outside this date window.
                </p>
                <div className="mt-2 mb-0 flex flex-wrap items-center gap-3">
                  {currency ? (
                    <Button type="button" variant="secondary" onClick={() => setCurrency('')}>
                      Show all currencies
                    </Button>
                  ) : null}
                  {(dateFrom || dateTo) && (
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => {
                        setDateFrom('')
                        setDateTo('')
                      }}
                    >
                      Show all dates
                    </Button>
                  )}
                </div>
              </div>
            ) : null
          ) : (
            <div className="flex flex-col gap-2.5">
              {chartData.map((entry) => {
                // Bar length is the share of the largest category by magnitude
                // (chartData is sorted by abs desc, so [0] is the max).
                const pct =
                  (Math.abs(entry.total) / (Math.abs(chartData[0].total) || 1)) * 100
                return (
                  <button
                    key={entry.name}
                    type="button"
                    onClick={() => navigateToCategory(entry.name)}
                    className="grid grid-cols-[minmax(96px,150px)_1fr_auto] items-center gap-3 rounded-md px-1 py-1 text-left transition-colors hover:bg-muted/40"
                  >
                    <CategoryPill category={entry.name.toLowerCase()} label={entry.name} size="sm" />
                    {/* gradient-hero token bar — color-mix/gradient has no Tailwind utility */}
                    <span
                      className="h-[18px] rounded"
                      style={{ background: 'var(--gradient-hero)', width: `${Math.max(2, pct)}%`, opacity: 0.85 }}
                      aria-hidden="true"
                    />
                    <span className="justify-self-end tabular-nums">
                      {/* total is the negated net spend; flip back so spend shows as −$ (out). */}
                      <AmountText value={-entry.total} currency={currency || undefined} decimals={0} size="sm" />
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </BentoTile>

        <BentoTile
          span={6}
          rows={1}
          aria-busy={loading}
          label="Monthly flow"
          description="Gross spend, refunds / credits, and payments / transfers by month."
        >
          {monthlyBreakdownData.length === 0 ? (
            !loading ? (
              <p className="m-0 text-muted-foreground">No monthly breakdown data for these filters.</p>
            ) : null
          ) : (
            <ResponsiveContainer width="100%" height={110}>
              <BarChart data={monthlyBreakdownData} margin={narrowChartMargin}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis
                  dataKey="month"
                  tick={narrowAxisTick}
                  tickFormatter={monthTickFormatter}
                  // preserveStartEnd at every viewport: with ~16 months of data,
                  // forcing interval={0} on wide caused Recharts to fragment the
                  // year-prefixed labels. preserveStartEnd lets it drop interior
                  // ticks to keep the start/end pinned. minTickGap widens the
                  // spacing once the short "Jan"/"Feb" labels fit.
                  interval="preserveStartEnd"
                  minTickGap={isNarrowViewport ? 12 : 24}
                />
                <YAxis
                  tick={narrowAxisTick}
                  width={isNarrowViewport ? 44 : 60}
                  tickFormatter={compactCurrencyTickFormatter}
                />
                <Tooltip
                  contentStyle={CHART_TOOLTIP_STYLE}
                  labelStyle={CHART_TOOLTIP_LABEL_STYLE}
                  itemStyle={CHART_TOOLTIP_ITEM_STYLE}
                  cursor={CHART_TOOLTIP_CURSOR}
                  formatter={(value) => {
                    const v = typeof value === 'number' ? value : Number(value)
                    if (!Number.isFinite(v)) return ''
                    return formatDashboardAmount(v)
                  }}
                />
                <Legend
                  verticalAlign="bottom"
                  align="center"
                  wrapperStyle={{ fontSize: 11 }}
                />
                <Bar dataKey="totalSpend" name="Spend" fill="var(--chart-spend)" />
                <Bar dataKey="totalCredits" name="Refunds / credits" fill="var(--chart-credit)" />
                <Bar
                  dataKey="totalPayments"
                  name="Payments / transfers"
                  fill="var(--chart-payment)"
                />
              </BarChart>
            </ResponsiveContainer>
          )}
        </BentoTile>

        <BentoTile
          span={6}
          rows={1}
          label="Activity by month"
          description="One line per currency using signed monthly totals, excluding payments and transfers."
        >
          {monthlyChartData.length === 0 ? (
            !loading ? <p className="text-sm leading-6 text-muted-foreground">No transactions in this range.</p> : null
          ) : (
            <ResponsiveContainer width="100%" height={110}>
              <LineChart data={monthlyChartData} margin={narrowChartMargin}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis
                  dataKey="month"
                  tick={narrowAxisTick}
                  tickFormatter={monthTickFormatter}
                  // See Monthly flow BarChart above for rationale — keep the two
                  // monthly axes in lockstep.
                  interval="preserveStartEnd"
                  minTickGap={isNarrowViewport ? 12 : 24}
                />
                <YAxis
                  tick={narrowAxisTick}
                  width={isNarrowViewport ? 44 : 60}
                  tickFormatter={compactCurrencyTickFormatter}
                />
                <Tooltip
                  contentStyle={CHART_TOOLTIP_STYLE}
                  labelStyle={CHART_TOOLTIP_LABEL_STYLE}
                  itemStyle={CHART_TOOLTIP_ITEM_STYLE}
                  cursor={CHART_TOOLTIP_CURSOR}
                  formatter={(value, name) => {
                    // Recharts passes the raw dataset value through; with
                    // connectNulls={false} on the Line, missing-data points
                    // are literally null in the row. Suppress those tooltip
                    // entries entirely — Number(null) is 0, which would
                    // re-introduce the false "$0.00" the chart-line fix
                    // was meant to eliminate.
                    if (value == null) return null
                    const v = typeof value === 'number' ? value : Number(value)
                    if (!Number.isFinite(v)) return null
                    return formatCurrency(v, String(name))
                  }}
                />
                <Legend
                  verticalAlign="bottom"
                  align="center"
                  wrapperStyle={isNarrowViewport ? { fontSize: 11 } : undefined}
                />
                {monthlyLineKeys.map((c, i) => (
                  <Line
                    key={c}
                    type="monotone"
                    dataKey={c}
                    name={c}
                    stroke={LINE_COLORS[i % LINE_COLORS.length]}
                    dot={false}
                    strokeWidth={2}
                    connectNulls={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          )}
        </BentoTile>

        <TopGrowersTile
          currentRows={data?.categoryReports ?? []}
          previousRows={previousCategoryReports}
          hasComparisonPeriod={hasComparisonPeriod}
          currency={currency}
          loading={loading}
        />

        <DashboardCategorySection
          categoryTree={data?.categoryTree ?? []}
          currency={displayCurrency}
        />

        <RecurringThisMonthTile
          items={recurringItems}
          loading={recurringLoading}
        />

        <TableTile
          span={6}
          label="Top merchants"
          description="Highest net spend in this view."
          columns={merchantColumns}
          rows={merchantReportData.slice(0, 6)}
          rowKey={(r) => `${r.currency}:${r.merchant}`}
          onRowClick={(r) =>
            navigate(
              transactionsUrl(
                { merchant: r.merchant },
                { currency, dateFrom, dateTo }
              )
            )
          }
          viewAllLabel="All merchants in Reports"
          viewAllHref="/reports#merchants"
          emptyLabel="No merchant activity in this view."
          loading={loading}
        />

        <TableTile
          span={6}
          label="Top accounts"
          description="Highest net spend in this view."
          columns={accountColumns}
          rows={accountReportData.slice(0, 6)}
          rowKey={(r) => `${r.currency}:${r.accountId}`}
          onRowClick={(r) =>
            navigate(
              transactionsUrl(
                { account: String(r.accountId) },
                { currency, dateFrom, dateTo }
              )
            )
          }
          viewAllLabel="All accounts in Reports"
          viewAllHref="/reports#accounts"
          emptyLabel="No account activity in this view."
          loading={loading}
        />

        <CurrencyMixTile
          metrics={data?.metricsByCurrency ?? []}
          loading={loading}
        />

        <ReceiptCoverageTile currency={currency || null} />

        <LatestAlertsTile />

        <EmailedReceiptsTile />

        <ImportHealthTile currency={currency || null} />

        <TableTile
          span={12}
          label="Review queue"
          description="Flagged transactions in this view, most recent first."
          columns={reviewColumns}
          rows={reviewQueueData.slice(0, 6)}
          rowKey={(r) => String(r.id)}
          onRowClick={() => navigate('/review')}
          viewAllLabel="Open Review Inbox"
          viewAllHref="/review"
          emptyLabel="Nothing flagged in this view."
          loading={loading}
        />
      </div>
      )}
    </div>
  )
}
