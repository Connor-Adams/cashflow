import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { FilterX } from 'lucide-react'
import { CategoryIcon } from '../components/CategoryIcon'
import { Link, useNavigate } from 'react-router-dom'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { FilterBar, type QuickRange } from '@/components/ui/filter-bar'
import { PageHeader } from '@/components/ui/page-header'
import { BentoTile } from '@/components/dashboard/BentoTile'
import { HeroTile } from '@/components/dashboard/HeroTile'
import { KpiStack } from '@/components/dashboard/KpiStack'
import { TopGrowersTile } from '@/components/dashboard/TopGrowersTile'
import { RecurringThisMonthTile } from '@/components/dashboard/RecurringThisMonthTile'
import { CurrencyMixTile } from '@/components/dashboard/CurrencyMixTile'
import { TableTile, type TableTileColumn } from '@/components/dashboard/TableTile'
import { SeverityBadge, type InsightSeverity } from '@/components/ai/SeverityBadge'
import { useInsightsSeen } from '@/hooks/useInsightsSeen'
import { useAuth } from '@/lib/useAuth'
import { formatMoney } from '../lib/formatMoney'
import { rankByNetSpend } from '../lib/rankByNetSpend'
import { summaryQueryString } from '../lib/summaryQuery'
import { getJson } from '../lib/api'
import { toDateInputValue } from '../lib/dateInput'
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
} from '../types/api'

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
  netSpend: number
  transactionCount: number
}

type MonthlyCurrencyBreakdown = {
  month: string
  currency: string
  totalSpend: number
  totalCredits: number
  totalPayments: number
  netSpend: number
}

type BusinessReportRow = {
  currency: string
  business: boolean
  totalSpend: number
  totalCredits: number
  netSpend: number
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
}

type MonthlyResp = {
  points: { month: string; currency: string; sumAmount: number }[]
}

type AiInsight = {
  title: string
  summary: string
  severity: InsightSeverity
  metric: string
  amount: number
  comparison: string
  supportingTransactionIds: number[]
  rationale: string
  suggestedAction: string
}

type AiInsightsResp = {
  period: string
  currency: string
  insights: AiInsight[]
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

function parseDateInput(value: string): Date | null {
  const parts = value.split('-').map((p) => Number(p))
  if (parts.length !== 3) return null
  const [y, m, d] = parts
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) {
    return null
  }
  const out = new Date(y, m - 1, d)
  if (Number.isNaN(out.getTime())) return null
  return out
}

function getPreviousRange(
  dateFrom: string,
  dateTo: string
): { from: string; to: string } | null {
  const from = parseDateInput(dateFrom)
  const to = parseDateInput(dateTo)
  if (!from || !to || from > to) return null
  const dayMs = 24 * 60 * 60 * 1000
  const spanDays = Math.floor((to.getTime() - from.getTime()) / dayMs) + 1
  const prevTo = new Date(from.getTime() - dayMs)
  const prevFrom = new Date(prevTo.getTime() - (spanDays - 1) * dayMs)
  return { from: toDateInputValue(prevFrom), to: toDateInputValue(prevTo) }
}

function getDefaultDashboardRange(): { from: string; to: string } {
  const to = new Date()
  const from = new Date(to)
  from.setDate(from.getDate() - 30)
  return { from: toDateInputValue(from), to: toDateInputValue(to) }
}

function getRollingMonthRange(months: number): { from: string; to: string } {
  const to = new Date()
  const from = new Date(to)
  from.setMonth(from.getMonth() - months)
  return { from: toDateInputValue(from), to: toDateInputValue(to) }
}

function getYearToDateRange(): { from: string; to: string } {
  const to = new Date()
  const from = new Date(to.getFullYear(), 0, 1)
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
  const [aiInsights, setAiInsights] = useState<AiInsightsResp | null>(null)
  const [budgetProgress, setBudgetProgress] = useState<BudgetProgress[]>([])
  // Recurring charges, fetched separately so a /api/recurring failure
  // never tanks the rest of the dashboard. Empty list on failure or
  // initial load.
  const [recurringItems, setRecurringItems] = useState<RecurringItem[]>([])
  const [recurringLoading, setRecurringLoading] = useState(true)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const auth = useAuth()
  const userIdForSeen = String(auth.user?.id ?? 'anon')
  const { isSeen, markSeen } = useInsightsSeen(userIdForSeen)
  const sortedInsights = aiInsights
    ? [...aiInsights.insights].sort((a, b) => {
        const order: Record<string, number> = { action: 0, watch: 1, info: 2 }
        return (order[a.severity] ?? 3) - (order[b.severity] ?? 3)
      })
    : []
  const hasActionSeverity = sortedInsights.some((i) => i.severity === 'action')

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
        const insightQs = new URLSearchParams({
          currency,
          period: (dateTo || new Date().toISOString()).slice(0, 7),
        })
        insightQs.set('dateFrom', dateFrom)
        insightQs.set('dateTo', dateTo)
        const [d, m, prev, insights] = await Promise.all([
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
          currency
            ? getJson<AiInsightsResp>(
                `/api/ai/insights?${insightQs.toString()}`
              )
            : Promise.resolve<AiInsightsResp | null>(null),
        ])
        if (!cancelled) {
          setData(d)
          setMonthly(m)
          setPreviousMetricsByCurrency(prev?.metricsByCurrency ?? [])
          setPreviousCategoryReports(prev?.categoryReports ?? [])
          setAiInsights(insights)
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
      const label = r.category ?? '(uncategorized)'
      byCat.set(label, (byCat.get(label) ?? 0) + r.sumAmount)
    }
    // Flip sign so spend reads as positive money-out. Charges land in the DB
    // as negative; refunds/credits as positive. After negation a typical
    // spend category shows a positive bar (going up), and a category that
    // net-refunded shows a negative bar (going down) which reads as
    // "money came back from this category".
    return Array.from(byCat.entries()).map(([name, total]) => ({ name, total: -total }))
  }, [data, currency])

  // Threshold for switching the category-axis layout. Above this count,
  // labels overlap even on a wide viewport with default tick spacing.
  const hasManyCategories = chartData.length > 10

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

  const businessReportData = useMemo(() => {
    const rows = data?.netSpendByBusiness ?? []
    const byFlag = new Map<
      string,
      {
        label: string
        tone: 'business' | 'personal'
        totalSpend: number
        totalCredits: number
        netSpend: number
      }
    >()
    for (const row of rows) {
      if (currency && row.currency !== currency) continue
      const key = row.business ? 'Business' : 'Personal'
      const existing = byFlag.get(key) ?? {
        label: key,
        tone: row.business ? 'business' : 'personal',
        totalSpend: 0,
        totalCredits: 0,
        netSpend: 0,
      }
      existing.totalSpend += row.totalSpend
      existing.totalCredits += row.totalCredits
      existing.netSpend += row.netSpend
      byFlag.set(key, existing)
    }
    return Array.from(byFlag.values()).sort((a, b) => b.netSpend - a.netSpend)
  }, [data?.netSpendByBusiness, currency])

  const businessSpotlight = useMemo(() => {
    const business =
      businessReportData.find((row) => row.tone === 'business') ?? {
        label: 'Business',
        tone: 'business' as const,
        totalSpend: 0,
        totalCredits: 0,
        netSpend: 0,
      }
    const personal =
      businessReportData.find((row) => row.tone === 'personal') ?? {
        label: 'Personal',
        tone: 'personal' as const,
        totalSpend: 0,
        totalCredits: 0,
        netSpend: 0,
      }
    const totalNetSpend = business.netSpend + personal.netSpend
    const totalGrossSpend = business.totalSpend + personal.totalSpend
    const totalCredits = business.totalCredits + personal.totalCredits
    const safeTotal = totalNetSpend > 0 ? totalNetSpend : 0
    const businessShare = safeTotal === 0 ? 0 : (business.netSpend / safeTotal) * 100
    const personalShare = safeTotal === 0 ? 0 : (personal.netSpend / safeTotal) * 100

    return {
      business,
      personal,
      totalNetSpend,
      totalGrossSpend,
      totalCredits,
      businessShare,
      personalShare,
    }
  }, [businessReportData])

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
    const spendTotal = selected.reduce((sum, row) => sum + row.totalSpend, 0)
    const creditTotal = selected.reduce((sum, row) => sum + row.totalCredits, 0)
    const paymentTotal = selected.reduce((sum, row) => sum + row.totalPayments, 0)
    const netSpendTotal = selected.reduce((sum, row) => sum + row.netSpend, 0)
    const txCount = selected.reduce((sum, row) => sum + row.transactionCount, 0)
    const prevSpendTotal = prevSelected.reduce((sum, row) => sum + row.totalSpend, 0)
    const prevCreditTotal = prevSelected.reduce((sum, row) => sum + row.totalCredits, 0)
    const prevPaymentTotal = prevSelected.reduce(
      (sum, row) => sum + row.totalPayments,
      0
    )
    const prevNetSpendTotal = prevSelected.reduce((sum, row) => sum + row.netSpend, 0)
    const prevTxCount = prevSelected.reduce((sum, row) => sum + row.transactionCount, 0)
    const singleCurrency = selected.length === 1 ? selected[0].currency : null
    // When previousRange is null the deltas are suppressed (HeroTile / KpiStack
    // skip the badges), so the hint at the bottom needs to explain *why* there
    // are no comparison numbers rather than read as a generic footnote under
    // populated totals.
    const comparisonHint =
      previousRange == null
        ? 'Period comparison unavailable — pick a start AND end date.'
        : `${previousRange.from} to ${previousRange.to}`
    const spendDelta = spendTotal - prevSpendTotal
    const creditDelta = creditTotal - prevCreditTotal
    const paymentDelta = paymentTotal - prevPaymentTotal
    const netSpendDelta = netSpendTotal - prevNetSpendTotal
    const txDelta = txCount - prevTxCount
    const formatDeltaMoney = (v: number): string => {
      const abs = Math.abs(v)
      const sign = v > 0 ? '+' : v < 0 ? '-' : ''
      if (singleCurrency == null) return `${sign}${abs.toFixed(2)}`
      return `${sign}${formatMoney(abs, singleCurrency)}`
    }
    const formatDeltaCount = (v: number): string =>
      `${v > 0 ? '+' : ''}${Math.trunc(v)}`
    // The previous-period prefix lives on Dashboard's delta strings so the
    // shared StatCard renders it inside the colored badge. Sign detection in
    // stat-card tolerates the leading descriptor.
    const withPrevPeriod = (label: string): string =>
      `vs previous period: ${label}`

    return {
      spendLabel:
        singleCurrency != null
          ? formatMoney(spendTotal, singleCurrency)
          : `${selected.length} currencies`,
      creditsLabel:
        singleCurrency != null
          ? formatMoney(creditTotal, singleCurrency)
          : `${selected.length} currencies`,
      paymentsLabel:
        singleCurrency != null
          ? formatMoney(paymentTotal, singleCurrency)
          : `${selected.length} currencies`,
      netSpendLabel:
        singleCurrency != null
          ? formatMoney(netSpendTotal, singleCurrency)
          : `${selected.length} currencies`,
      moneyHint:
        singleCurrency != null ? `In ${singleCurrency}` : 'Across selected currencies',
      txCount,
      spendDeltaLabel: withPrevPeriod(formatDeltaMoney(spendDelta)),
      creditsDeltaLabel: withPrevPeriod(formatDeltaMoney(creditDelta)),
      paymentsDeltaLabel: withPrevPeriod(formatDeltaMoney(paymentDelta)),
      netSpendDeltaLabel: withPrevPeriod(formatDeltaMoney(netSpendDelta)),
      txDeltaLabel: withPrevPeriod(formatDeltaCount(txDelta)),
      comparisonHint,
      merchantCount: merchantReportData.length,
      accountCount: accountReportData.length,
      reviewCount: reviewQueueData.length,
    }
  }, [
    data?.metricsByCurrency,
    previousMetricsByCurrency,
    previousRange,
    currency,
    merchantReportData.length,
    accountReportData.length,
    reviewQueueData.length,
  ])

  const activeRangeLabel = useMemo(() => {
    if (!dateFrom && !dateTo) return 'All dates'
    if (dateFrom && dateTo) return `${dateFrom} to ${dateTo}`
    if (dateFrom) return `From ${dateFrom}`
    return `Up to ${dateTo}`
  }, [dateFrom, dateTo])

  const quickRanges = useMemo<QuickRange[]>(
    () => [
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
      ? formatMoney(value, displayCurrency)
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

  // Column specs for the bento table-tiles. Defined inside the component
  // so the render closures can reference `formatMoney` directly without
  // tunneling it through the column spec.
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
      render: (r) => formatMoney(r.netSpend, r.currency),
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
      render: (r) => formatMoney(r.netSpend, r.currency),
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
      render: (r) => formatMoney(r.amount, r.currency),
    },
  ]

  return (
    <div className="page">
      <PageHeader
        title="Dashboard"
        description="Totals stay in each currency. Filter by currency and date range."
      />
      {err && <span className="error">{err}</span>}
      {loading && <p className="muted">Loading dashboard…</p>}

      {summaryStats.reviewCount > 0 ? (
        <Alert
          variant="warning"
          title={`${summaryStats.reviewCount} transaction${
            summaryStats.reviewCount === 1 ? '' : 's'
          } flagged for review`}
          action={
            <Link to="/review" className="text-sm font-semibold underline">
              Open Review Inbox
            </Link>
          }
        >
          Transactions flagged for review are waiting on category, split, or
          business decisions before they roll into your totals.
        </Alert>
      ) : null}

      <Card className="dashboardFilters mt-2 w-fit max-w-full p-2 sm:p-3">
        <CardContent className="p-0">
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
              <p
                className="muted"
                style={{
                  marginBottom: 0,
                  display: 'flex',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: '0.4rem',
                }}
              >
                Showing
                {/* Pill-style active-filter chip — reads as the currently
                    applied scope rather than a low-contrast footnote. Uses
                    --muted as the surface and --border for the outline to stay
                    on the brand token palette (no hex). */}
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.35rem',
                    padding: '0.25rem 0.65rem',
                    borderRadius: '9999px',
                    border: '1px solid var(--border)',
                    background: 'var(--muted)',
                    color: 'var(--foreground)',
                    fontSize: '0.8rem',
                    lineHeight: 1.2,
                  }}
                >
                  <strong>{currency || 'all currencies'}</strong>
                  <span style={{ color: 'var(--muted-foreground)' }}>·</span>
                  <strong>{activeRangeLabel}</strong>
                </span>
              </p>
            }
          />
        </CardContent>
      </Card>

      {hasActionSeverity ? (
        <div className="aiActionBanner" role="status">
          AI flagged {sortedInsights.filter((i) => i.severity === 'action').length} action item(s) this month.{' '}
          <a href="#ai-insights-tile">Jump to insights</a>
        </div>
      ) : null}

      <div className="dashboardBento" aria-busy={loading}>
        {budgetProgressSorted.length > 0 && (
          <BentoTile
            span={12}
            rows={1}
            aria-busy={loading}
            label="Monthly budget progress"
            description="Spend so far this calendar month against targets in Settings. Sorted by share used."
          >
            <div className="budgetPillStrip">
              {budgetProgressSorted.map((item) => {
                // Color thresholds: under 80% is on-pace, 80-100% warns,
                // over 100% spills to destructive. Bar fill capped at 100%
                // width so overage doesn't break layout; the percent caption
                // still shows the true value.
                const tone =
                  item.percentUsed > 100
                    ? 'over'
                    : item.percentUsed >= 80
                      ? 'warn'
                      : 'ok'
                const width = `${Math.min(100, item.percentUsed)}%`
                const label = item.category ?? 'Overall'
                const percentRounded = Math.round(item.percentUsed)
                return (
                  <article
                    key={item.budgetId}
                    className={`budgetPill budgetPill--${tone}`}
                  >
                    <header className="budgetPill__header">
                      <strong className="budgetPill__label inline-flex items-center gap-1.5 min-w-0" title={label}>
                        <CategoryIcon name={item.category} />
                        <span className="truncate">{label}</span>
                      </strong>
                      <span className="budgetPill__pct">{percentRounded}%</span>
                    </header>
                    <div
                      className="budgetPill__bar"
                      role="img"
                      aria-label={`${label} ${percentRounded} percent of monthly target used`}
                    >
                      <span
                        className="budgetPill__fill"
                        style={{ width }}
                      />
                    </div>
                    <p className="budgetPill__amount">
                      {formatMoney(item.spent, item.currency)} /{' '}
                      {formatMoney(item.target, item.currency)}{' '}
                      <span className="budgetPill__currency">{item.currency}</span>
                    </p>
                  </article>
                )
              })}
            </div>
          </BentoTile>
        )}

        <BentoTile
          span={8}
          rows={2}
          variant="hero"
          aria-busy={loading}
          aria-label="This period at a glance"
        >
          <HeroTile
            netSpendLabel={summaryStats.netSpendLabel}
            netSpendDelta={
              hasComparisonPeriod ? summaryStats.netSpendDeltaLabel : undefined
            }
            subMetrics={[
              {
                label: 'Spend',
                value: summaryStats.spendLabel,
                delta: hasComparisonPeriod
                  ? summaryStats.spendDeltaLabel
                  : undefined,
                metricKind: 'spend',
              },
              {
                label: 'Refunds / credits',
                value: summaryStats.creditsLabel,
                delta: hasComparisonPeriod
                  ? summaryStats.creditsDeltaLabel
                  : undefined,
                metricKind: 'gain',
              },
              {
                label: 'Payments / transfers',
                value: summaryStats.paymentsLabel,
                delta: hasComparisonPeriod
                  ? summaryStats.paymentsDeltaLabel
                  : undefined,
                metricKind: 'neutral',
              },
            ]}
            comparisonHint={summaryStats.comparisonHint}
            moneyHint={summaryStats.moneyHint}
            sparklineData={monthlyBreakdownData.map((m) => ({
              month: m.month,
              value: m.netSpend,
            }))}
          />
        </BentoTile>

        <BentoTile span={4} rows={2} aria-busy={loading} aria-label="Activity counts">
          <KpiStack
            items={[
              {
                label: 'Transactions',
                value: summaryStats.txCount,
                hint: 'Rows in current filters',
                delta: hasComparisonPeriod ? summaryStats.txDeltaLabel : undefined,
                metricKind: 'neutral',
              },
              {
                label: 'Merchants',
                value: summaryStats.merchantCount,
                hint: 'Distinct merchants',
                metricKind: 'neutral',
              },
              {
                label: 'Accounts',
                value: summaryStats.accountCount,
                hint: 'With activity in period',
                metricKind: 'neutral',
              },
            ]}
          />
        </BentoTile>

        <BentoTile
          span={6}
          rows={2}
          aria-busy={loading}
          label="Business vs personal"
          description="A direct split of current net spend so business charges do not get lost in the overall totals."
          actions={
            <div className="businessSpotlightTotals">
              <p className="businessSpotlightTotalLabel">Combined net spend</p>
              <p className="businessSpotlightTotalValue">
                {formatDashboardAmount(businessSpotlight.totalNetSpend)}
              </p>
            </div>
          }
        >
          <div className="businessSpotlightGrid">
            {[businessSpotlight.business, businessSpotlight.personal].map((row) => {
              const share =
                businessSpotlight.totalNetSpend > 0
                  ? (row.netSpend / businessSpotlight.totalNetSpend) * 100
                  : 0
              return (
                <article
                  key={row.label}
                  className={`businessFocusCard businessFocusCard--${row.tone}`}
                >
                  <p className="businessFocusLabel">{row.label}</p>
                  <p className="businessFocusValue">
                    {formatDashboardAmount(row.netSpend)}
                  </p>
                  <p className="businessFocusShare">
                    {businessSpotlight.totalNetSpend > 0
                      ? `${share.toFixed(0)}% of current net spend`
                      : 'No net spend in current filters'}
                  </p>
                  <dl className="businessFocusMetrics">
                    <div>
                      <dt>Gross spend</dt>
                      <dd>{formatDashboardAmount(row.totalSpend)}</dd>
                    </div>
                    <div>
                      <dt>Credits</dt>
                      <dd>{formatDashboardAmount(row.totalCredits)}</dd>
                    </div>
                  </dl>
                </article>
              )
            })}
          </div>

          <div className="businessSharePanel">
            <div className="businessShareLabels" aria-hidden="true">
              {/* Override the .businessShareLabels muted color: these split
                  percentages are load-bearing context for the bar below and
                  read as ghosted at --muted-foreground. Bumping to --foreground
                  + semibold restores them as primary labels. */}
              <span
                className="font-semibold"
                style={{ color: 'var(--foreground)' }}
              >
                Business {businessSpotlight.businessShare.toFixed(0)}%
              </span>
              <span
                className="font-semibold"
                style={{ color: 'var(--foreground)' }}
              >
                Personal {businessSpotlight.personalShare.toFixed(0)}%
              </span>
            </div>
            <div
              className="businessShareBar"
              role="img"
              aria-label={`Business ${businessSpotlight.businessShare.toFixed(
                0
              )} percent, personal ${businessSpotlight.personalShare.toFixed(
                0
              )} percent of net spend`}
            >
              <span
                className="businessShareFill businessShareFill--business"
                style={{ width: `${businessSpotlight.businessShare}%` }}
              />
              <span
                className="businessShareFill businessShareFill--personal"
                style={{ width: `${businessSpotlight.personalShare}%` }}
              />
            </div>
            <p className="muted businessShareCaption">
              Gross spend: {formatDashboardAmount(businessSpotlight.totalGrossSpend)}.
              Credits: {formatDashboardAmount(businessSpotlight.totalCredits)}.
            </p>
          </div>
        </BentoTile>

        <BentoTile
          span={6}
          rows={2}
          aria-busy={loading}
          label="Monthly flow"
          description="Gross spend, refunds / credits, and payments / transfers by month."
        >
          {monthlyBreakdownData.length === 0 ? (
            !loading ? (
              <p className="emptyState">No monthly breakdown data for these filters.</p>
            ) : null
          ) : (
            <ResponsiveContainer width="100%" height={220}>
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
          span={8}
          rows={2}
          aria-busy={loading}
          label="Net spend by category"
          description="Click a bar to open those transactions with the current filters applied. Payments and transfers are excluded."
        >
          {chartData.length === 0 ? (
            !loading ? (
              <div>
                <p className="emptyState">
                  No category totals for these filters. Your transactions may be in a
                  different currency or outside this date window.
                </p>
                <div className="row" style={{ marginTop: '0.5rem', marginBottom: 0 }}>
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
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={chartData} margin={narrowChartMargin}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis
                  dataKey="name"
                  // Category-count-aware label handling: once there are more
                  // than 10 categories, default Recharts spacing overlaps even
                  // on wide viewports. Steepen the angle and give the axis
                  // more vertical space so every label still renders without
                  // clipping (long names like "Snowboarding Gear" need both
                  // the steeper angle and the extra height to fit).
                  tick={hasManyCategories ? { fontSize: 11 } : narrowAxisTick}
                  interval={0}
                  minTickGap={isNarrowViewport ? 12 : 5}
                  angle={hasManyCategories ? -55 : 0}
                  textAnchor={hasManyCategories ? 'end' : 'middle'}
                  height={hasManyCategories ? 110 : undefined}
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
                    return currency
                      ? formatMoney(v, currency)
                      : new Intl.NumberFormat(undefined, {
                          maximumFractionDigits: 2,
                        }).format(v)
                  }}
                />
                <Bar
                  dataKey="total"
                  name="Net spend"
                  fill="var(--chart-spend)"
                  cursor="pointer"
                  onClick={(entry) => {
                    // Recharts hands us the data row as the click payload. Guard
                    // against missing/unexpected payloads — only navigate when we
                    // can read a category name.
                    const name =
                      entry && typeof entry === 'object' && 'name' in entry
                        ? String((entry as { name: unknown }).name ?? '')
                        : ''
                    if (name) navigateToCategory(name)
                  }}
                />
              </BarChart>
            </ResponsiveContainer>
          )}
          {chartData.length > 0 ? (
            <p className="muted" style={{ marginTop: '0.5rem', marginBottom: 0, fontSize: '0.75rem' }}>
              Jump to:{' '}
              {chartData.slice(0, 8).map((entry, index) => (
                <span key={entry.name}>
                  {index > 0 ? ', ' : ''}
                  <Link
                    to={`/transactions?${new URLSearchParams({
                      category: entry.name,
                      ...(currency ? { currency } : {}),
                      ...(dateFrom ? { dateFrom } : {}),
                      ...(dateTo ? { dateTo } : {}),
                    }).toString()}`}
                    className="font-semibold underline"
                  >
                    {entry.name}
                  </Link>
                </span>
              ))}
              {chartData.length > 8 ? '…' : '.'}
            </p>
          ) : null}
        </BentoTile>

        <BentoTile
          span={hasActionSeverity ? 6 : 4}
          rows={2}
          aria-busy={loading}
          label="AI insights"
          id="ai-insights-tile"
          description={
            aiInsights
              ? `${aiInsights.currency} · ${aiInsights.period}`
              : 'Awaiting fetch'
          }
        >
          <div className="aiVisibilityList">
            {!aiInsights ? (
              <p className="emptyState">
                {loading ? 'Loading insights…' : 'No insights available yet.'}
              </p>
            ) : aiInsights.insights.length === 0 ? (
              <p className="emptyState">No AI insights for {aiInsights.period} yet.</p>
            ) : (
              sortedInsights.map((insight) => {
                const unread = !isSeen(aiInsights.period, insight.metric, insight.title)
                return (
                  <article
                    key={`${insight.metric}-${insight.title}`}
                    className={`aiVisibilityItem${unread ? ' is-unread' : ''}`}
                    onClick={() => markSeen(aiInsights.period, insight.metric, insight.title)}
                  >
                    <div className="aiVisibilityItemHeader">
                      {unread ? <span className="unreadDot" aria-label="New" /> : null}
                      <strong>{insight.title}</strong>
                      <SeverityBadge severity={insight.severity} />
                    </div>
                    <p>{insight.summary}</p>
                    <p className="muted">
                      {insight.comparison} · {formatDashboardAmount(insight.amount)}
                    </p>
                    {insight.supportingTransactionIds.length > 0 ? (
                      <p className="muted aiVisibilitySupportingIds">
                        Transactions:{' '}
                        {insight.supportingTransactionIds.map((id, idx) => (
                          <span key={`${id}-${idx}`}>
                            {idx > 0 ? ', ' : null}
                            <Link to={`/transactions?ids=${id}`}>#{id}</Link>
                          </span>
                        ))}
                      </p>
                    ) : null}
                    <p className="muted">{insight.suggestedAction}</p>
                    {insight.supportingTransactionIds.length > 0 ? (
                      <Link
                        to={`/transactions?ids=${insight.supportingTransactionIds.join(',')}`}
                        className="aiVisibilityAction"
                      >
                        Open these transactions
                      </Link>
                    ) : null}
                  </article>
                )
              })
            )}
          </div>
        </BentoTile>

        <BentoTile
          span={6}
          rows={2}
          label="Activity by month"
          description="One line per currency using signed monthly totals, excluding payments and transfers."
        >
          {monthlyChartData.length === 0 ? (
            !loading ? <p className="muted">No transactions in this range.</p> : null
          ) : (
            <ResponsiveContainer width="100%" height={220}>
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
                    return formatMoney(v, String(name))
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

        <RecurringThisMonthTile
          items={recurringItems}
          loading={recurringLoading}
        />

        <CurrencyMixTile
          metrics={data?.metricsByCurrency ?? []}
          loading={loading}
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
    </div>
  )
}
