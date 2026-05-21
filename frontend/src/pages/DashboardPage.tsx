import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { FilterX } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { FilterBar, type QuickRange } from '@/components/ui/filter-bar'
import { PageHeader } from '@/components/ui/page-header'
import { StatCard } from '@/components/ui/stat-card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatMoney } from '../lib/formatMoney'
import { summaryQueryString } from '../lib/summaryQuery'
import { getJson } from '../lib/api'
import { toDateInputValue } from '../lib/dateInput'
import { useSessionState } from '../lib/useSessionState'
import {
  formatCompactMoney,
  formatShortMonth,
  useIsNarrowViewport,
} from '../lib/chartViewport'

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
  severity: 'info' | 'watch' | 'action'
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

const LINE_COLORS = [
  'var(--primary)',
  '#94a3b8',
  '#f59e0b',
  '#22c55e',
  '#8b5cf6',
  '#ec4899',
]
const DEFAULT_DASHBOARD_CURRENCY = 'CAD'
const BUSINESS_COLOR = '#f59e0b'
const PERSONAL_COLOR = '#22c55e'
const CHART_TOOLTIP_STYLE = {
  backgroundColor: 'rgba(11, 16, 22, 0.96)',
  border: '1px solid rgba(119, 167, 255, 0.28)',
  borderRadius: '14px',
  boxShadow: '0 18px 40px rgba(0, 0, 0, 0.4)',
  color: '#eef3f8',
}
const CHART_TOOLTIP_LABEL_STYLE = {
  color: '#eef3f8',
  fontWeight: 600,
  marginBottom: '0.35rem',
}
const CHART_TOOLTIP_ITEM_STYLE = {
  color: '#eef3f8',
  padding: 0,
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
  const [monthly, setMonthly] = useState<MonthlyResp | null>(null)
  const [aiInsights, setAiInsights] = useState<AiInsightsResp | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

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
    return Array.from(byCat.entries()).map(([name, total]) => ({ name, total }))
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
      const qs = new URLSearchParams()
      qs.set('category', categoryName)
      if (currency) qs.set('currency', currency)
      if (dateFrom) qs.set('dateFrom', dateFrom)
      if (dateTo) qs.set('dateTo', dateTo)
      navigate(`/transactions?${qs.toString()}`)
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
      const row: Record<string, string | number> = { month }
      for (const c of monthlyLineKeys) {
        row[c] = lookup.get(month)?.get(c) ?? 0
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
        fill: string
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
        fill: row.business ? BUSINESS_COLOR : PERSONAL_COLOR,
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
        fill: BUSINESS_COLOR,
        totalSpend: 0,
        totalCredits: 0,
        netSpend: 0,
      }
    const personal =
      businessReportData.find((row) => row.tone === 'personal') ?? {
        label: 'Personal',
        tone: 'personal' as const,
        fill: PERSONAL_COLOR,
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

  const categoryReportData = useMemo(() => {
    const rows = data?.categoryReports ?? []
    return rows
      .filter((row) => !currency || row.currency === currency)
      .slice()
      .sort((a, b) => b.netSpend - a.netSpend)
  }, [data?.categoryReports, currency])

  const merchantReportData = useMemo(() => {
    const rows = data?.merchantSummaries ?? []
    return rows
      .filter((row) => !currency || row.currency === currency)
      .slice()
      .sort((a, b) =>
        b.netSpend === a.netSpend
          ? b.transactionCount - a.transactionCount
          : b.netSpend - a.netSpend
      )
  }, [data?.merchantSummaries, currency])

  const accountReportData = useMemo(() => {
    const rows = data?.accountSummaries ?? []
    return rows
      .filter((row) => !currency || row.currency === currency)
      .slice()
      .sort((a, b) =>
        b.netSpend === a.netSpend
          ? b.transactionCount - a.transactionCount
          : b.netSpend - a.netSpend
      )
  }, [data?.accountSummaries, currency])

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
    const comparisonHint =
      previousRange == null
        ? 'Set both dates for period comparison.'
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

  // When the view is unbounded on both ends ("All time"), there is no prior
  // window to compare against — the previous-period totals collapse to zero
  // and any rendered delta is misleading (always "+ entire amount" in green).
  // Suppress the delta prop in that case; StatCard handles `undefined` by not
  // rendering the badge.
  const hasComparisonPeriod = Boolean(dateFrom || dateTo)

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
  const monthTickFormatter = (value: string | number): string => {
    if (typeof value !== 'string') return String(value)
    return isNarrowViewport ? formatShortMonth(value) : value
  }

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

      <Card className="dashboardFilters">
        <CardContent className="p-0">
          <FilterBar
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
              <p className="muted" style={{ marginBottom: 0 }}>
                Showing <strong>{currency || 'all currencies'}</strong> for{' '}
                <strong>{activeRangeLabel}</strong>.
              </p>
            }
          />
        </CardContent>
      </Card>

      <section className="dashboardStats" aria-busy={loading}>
        <StatCard
          label="Total spend"
          value={summaryStats.spendLabel}
          hint={`Charges only (absolute values). ${summaryStats.moneyHint}`}
          delta={hasComparisonPeriod ? summaryStats.spendDeltaLabel : undefined}
          metricKind="spend"
        />
        <StatCard
          label="Refunds / credits"
          value={summaryStats.creditsLabel}
          hint="Positive amounts excluding payments and transfers."
          delta={hasComparisonPeriod ? summaryStats.creditsDeltaLabel : undefined}
          metricKind="gain"
        />
        <StatCard
          label="Payments / transfers"
          value={summaryStats.paymentsLabel}
          hint="Card payments and transfer-like inflows, tracked separately."
          delta={hasComparisonPeriod ? summaryStats.paymentsDeltaLabel : undefined}
          metricKind="neutral"
        />
        <StatCard
          label="Net spend"
          value={summaryStats.netSpendLabel}
          hint="Spend minus refunds/credits. Payments excluded."
          delta={hasComparisonPeriod ? summaryStats.netSpendDeltaLabel : undefined}
          metricKind="spend"
        />
        <StatCard
          label="Transactions"
          value={summaryStats.txCount}
          hint="Rows in current filters"
          delta={hasComparisonPeriod ? summaryStats.txDeltaLabel : undefined}
          metricKind="neutral"
        />
        <StatCard
          label="Merchants"
          value={summaryStats.merchantCount}
          hint="Distinct merchants in the current filters"
          metricKind="neutral"
        />
        <StatCard
          label="Accounts"
          value={summaryStats.accountCount}
          hint="Accounts contributing activity in this view"
          metricKind="neutral"
        />
      </section>

      {aiInsights && (
        <section className="card dashboardChartCard" aria-busy={loading}>
          <h2>AI insights</h2>
          <p className="muted">
            Calculated from finalized {aiInsights.currency} transactions for{' '}
            {aiInsights.period}; supporting transaction ids are shown for audit.
          </p>
          <div className="aiVisibilityList">
            {aiInsights.insights.length === 0 ? (
              <p className="emptyState">No AI insights for this period yet.</p>
            ) : (
              aiInsights.insights.map((insight) => (
                <article key={`${insight.metric}-${insight.title}`} className="aiVisibilityItem">
                  <div className="aiVisibilityItemHeader">
                    <strong>{insight.title}</strong>
                    <span className="muted">{insight.severity}</span>
                  </div>
                  <p>{insight.summary}</p>
                  <p className="muted">
                    {insight.comparison} · {formatDashboardAmount(insight.amount)}
                  </p>
                  {insight.supportingTransactionIds.length > 0 ? (
                    <p className="muted">
                      Transactions: #{insight.supportingTransactionIds.join(', #')}
                    </p>
                  ) : null}
                  <p className="muted">{insight.suggestedAction}</p>
                </article>
              ))
            )}
          </div>
        </section>
      )}

      <section className="card dashboardBusinessSpotlight" aria-busy={loading}>
        <div className="businessSpotlightHeader">
          <div>
            <h2>Business vs personal</h2>
            <p className="muted">
              A direct split of current net spend so business charges do not get lost
              in the overall totals.
            </p>
          </div>
          <div className="businessSpotlightTotals">
            <p className="businessSpotlightTotalLabel">Combined net spend</p>
            <p className="businessSpotlightTotalValue">
              {formatDashboardAmount(businessSpotlight.totalNetSpend)}
            </p>
          </div>
        </div>

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
            <span>Business {businessSpotlight.businessShare.toFixed(0)}%</span>
            <span>Personal {businessSpotlight.personalShare.toFixed(0)}%</span>
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
      </section>

      <section className="card dashboardChartCard" aria-busy={loading}>
        <h2>Monthly breakdown</h2>
        <p className="muted">
          Gross spend, refunds/credits, and payments/transfers by month.
        </p>
        <div className="chartWrap">
          {monthlyBreakdownData.length === 0 ? (
            !loading ? (
              <p className="emptyState">No monthly breakdown data for these filters.</p>
            ) : null
          ) : (
            <ResponsiveContainer width="100%" height={isNarrowViewport ? 280 : 320}>
              <BarChart data={monthlyBreakdownData} margin={narrowChartMargin}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  dataKey="month"
                  tick={narrowAxisTick}
                  tickFormatter={monthTickFormatter}
                  interval={isNarrowViewport ? 'preserveStartEnd' : 0}
                  minTickGap={isNarrowViewport ? 12 : 5}
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
                  formatter={(value) => {
                    const v = typeof value === 'number' ? value : Number(value)
                    if (!Number.isFinite(v)) return ''
                    return formatDashboardAmount(v)
                  }}
                />
                <Legend
                  verticalAlign="bottom"
                  align="center"
                  wrapperStyle={isNarrowViewport ? { fontSize: 11 } : undefined}
                />
                <Bar dataKey="totalSpend" name="Spend" fill="var(--primary)" />
                <Bar dataKey="totalCredits" name="Refunds / credits" fill="#22c55e" />
                <Bar
                  dataKey="totalPayments"
                  name="Payments / transfers"
                  fill="#94a3b8"
                />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </section>

      <section
        className="card dashboardChartCard"
        aria-busy={loading}
        aria-label="Activity by category. Click a bar to view its transactions."
      >
        <h2>Activity by category</h2>
        <p className="muted">
          Signed totals by category. Click a bar to open those transactions with the
          current filters applied. Payments and transfers are excluded; refunds and
          credits remain positive.
        </p>
        <div className="chartWrap">
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
            <ResponsiveContainer width="100%" height={isNarrowViewport ? 260 : 320}>
              <BarChart data={chartData} margin={narrowChartMargin}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  dataKey="name"
                  tick={narrowAxisTick}
                  // Category-count-aware label handling: once there are more
                  // than 10 categories, default Recharts spacing overlaps even
                  // on wide viewports. Steepen the angle and give the axis
                  // more vertical space so every label still renders (using
                  // preserveStartEnd silently dropped every other label,
                  // hiding big categories like Rent under the tallest bar).
                  // Narrow viewport stacks the tick-font shrink on top.
                  interval={0}
                  minTickGap={isNarrowViewport ? 12 : 5}
                  angle={hasManyCategories ? -45 : 0}
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
                {!isNarrowViewport && (
                  <Legend verticalAlign="bottom" align="center" />
                )}
                <Bar
                  dataKey="total"
                  name="Amount"
                  fill="var(--primary)"
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
        </div>
        {chartData.length > 0 ? (
          <p className="muted" style={{ marginTop: '0.5rem', marginBottom: 0 }}>
            Jump to transactions:{' '}
            {chartData.map((entry, index) => (
              <span key={entry.name}>
                {index > 0 ? ', ' : ''}
                <Link
                  to={`/transactions?${new URLSearchParams({
                    category: entry.name,
                    ...(currency ? { currency } : {}),
                    ...(dateFrom ? { dateFrom } : {}),
                    ...(dateTo ? { dateTo } : {}),
                  }).toString()}`}
                  className="text-sm font-semibold underline"
                >
                  {entry.name}
                </Link>
              </span>
            ))}
            .
          </p>
        ) : null}
      </section>

      <section className="card dashboardChartCard" aria-busy={loading}>
        <h2>Net spend by business flag</h2>
        <p className="muted">
          Same split, charted directly with separate business and personal colors.
        </p>
        <div className="chartWrap">
          {businessReportData.length === 0 ? (
            !loading ? (
              <p className="emptyState">No business breakdown data for these filters.</p>
            ) : null
          ) : (
            <ResponsiveContainer width="100%" height={isNarrowViewport ? 240 : 280}>
              <BarChart data={businessReportData} margin={narrowChartMargin}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="label" tick={narrowAxisTick} />
                <YAxis
                  tick={narrowAxisTick}
                  width={isNarrowViewport ? 44 : 60}
                  tickFormatter={compactCurrencyTickFormatter}
                />
                <Tooltip
                  contentStyle={CHART_TOOLTIP_STYLE}
                  labelStyle={CHART_TOOLTIP_LABEL_STYLE}
                  itemStyle={CHART_TOOLTIP_ITEM_STYLE}
                  formatter={(value) => {
                    const v = typeof value === 'number' ? value : Number(value)
                    if (!Number.isFinite(v)) return ''
                    return formatDashboardAmount(v)
                  }}
                />
                {!isNarrowViewport && (
                  <Legend verticalAlign="bottom" align="center" />
                )}
                <Bar dataKey="netSpend" name="Net spend">
                  {businessReportData.map((entry) => (
                    <Cell key={entry.label} fill={entry.fill} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </section>

      <section className="card dashboardChartCard">
        <h2>Activity by month</h2>
        <p className="muted">
          One line per currency using signed monthly totals, excluding payments and
          transfers.
        </p>
        <div className="chartWrap">
          {monthlyChartData.length === 0 ? (
            !loading ? <p className="muted">No transactions in this range.</p> : null
          ) : (
            <ResponsiveContainer width="100%" height={isNarrowViewport ? 280 : 320}>
              <LineChart data={monthlyChartData} margin={narrowChartMargin}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  dataKey="month"
                  tick={narrowAxisTick}
                  tickFormatter={monthTickFormatter}
                  interval={isNarrowViewport ? 'preserveStartEnd' : 0}
                  minTickGap={isNarrowViewport ? 12 : 5}
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
                  formatter={(value, name) => {
                    const v = typeof value === 'number' ? value : Number(value)
                    if (!Number.isFinite(v)) return ''
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
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </section>

      <section className="card dashboardChartCard" aria-busy={loading}>
        <h2>Category report</h2>
        <p className="muted">
          Top categories ranked by net spend for the current filters.
        </p>
        <div className="tableWrap">
          <Table className="table">
            <TableHeader>
              <TableRow>
                {!currency && <TableHead>Currency</TableHead>}
                <TableHead>Category</TableHead>
                <TableHead>Spend</TableHead>
                <TableHead>Refunds / credits</TableHead>
                <TableHead>Net spend</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!loading && categoryReportData.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={currency ? 4 : 5}
                    className="emptyStateCell"
                  >
                    <p className="emptyState">
                      No category report data for these filters.
                    </p>
                  </TableCell>
                </TableRow>
              ) : null}
              {categoryReportData.slice(0, 12).map((row) => (
                  <TableRow key={`${row.currency}:${row.category ?? 'uncategorized'}`}>
                    {!currency && <TableCell>{row.currency}</TableCell>}
                    <TableCell>{row.category ?? '(uncategorized)'}</TableCell>
                    <TableCell>{formatMoney(row.totalSpend, row.currency)}</TableCell>
                    <TableCell>{formatMoney(row.totalCredits, row.currency)}</TableCell>
                    <TableCell>{formatMoney(row.netSpend, row.currency)}</TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <section className="card dashboardChartCard" aria-busy={loading}>
        <h2>Merchant report</h2>
        <p className="muted">
          Where the money is actually going, ranked by net spend with refunds,
          payments, and review backlog shown beside it.
        </p>
        <div className="tableWrap">
          <Table className="table">
            <TableHeader>
              <TableRow>
                {!currency && <TableHead>Currency</TableHead>}
                <TableHead>Merchant</TableHead>
                <TableHead>Transactions</TableHead>
                <TableHead>Spend</TableHead>
                <TableHead>Refunds / credits</TableHead>
                <TableHead>Payments</TableHead>
                <TableHead>Net spend</TableHead>
                <TableHead>Needs review</TableHead>
                <TableHead>Last seen</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!loading && merchantReportData.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={currency ? 8 : 9} className="emptyStateCell">
                    <p className="emptyState">
                      No merchant-level activity for these filters.
                    </p>
                  </TableCell>
                </TableRow>
              ) : null}
              {merchantReportData.slice(0, 12).map((row) => (
                  <TableRow key={`${row.currency}:${row.merchant}`}>
                    {!currency && <TableCell>{row.currency}</TableCell>}
                    <TableCell>{row.merchant}</TableCell>
                    <TableCell>{row.transactionCount}</TableCell>
                    <TableCell>{formatMoney(row.totalSpend, row.currency)}</TableCell>
                    <TableCell>{formatMoney(row.totalCredits, row.currency)}</TableCell>
                    <TableCell>{formatMoney(row.totalPayments, row.currency)}</TableCell>
                    <TableCell>{formatMoney(row.netSpend, row.currency)}</TableCell>
                    <TableCell>{row.reviewCount}</TableCell>
                    <TableCell>{row.lastDate}</TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <section className="card dashboardChartCard" aria-busy={loading}>
        <h2>Account report</h2>
        <p className="muted">
          Which accounts are driving the totals, including payment volume and review
          backlog.
        </p>
        <div className="tableWrap">
          <Table className="table">
            <TableHeader>
              <TableRow>
                {!currency && <TableHead>Currency</TableHead>}
                <TableHead>Account</TableHead>
                <TableHead>Transactions</TableHead>
                <TableHead>Spend</TableHead>
                <TableHead>Refunds / credits</TableHead>
                <TableHead>Payments</TableHead>
                <TableHead>Net spend</TableHead>
                <TableHead>Needs review</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!loading && accountReportData.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={currency ? 7 : 8} className="emptyStateCell">
                    <p className="emptyState">
                      No account-level totals for these filters.
                    </p>
                  </TableCell>
                </TableRow>
              ) : null}
              {accountReportData.map((row) => (
                  <TableRow key={`${row.currency}:${row.accountId}`}>
                    {!currency && <TableCell>{row.currency}</TableCell>}
                    <TableCell>{row.accountShortCode ?? row.accountName}</TableCell>
                    <TableCell>{row.transactionCount}</TableCell>
                    <TableCell>{formatMoney(row.totalSpend, row.currency)}</TableCell>
                    <TableCell>{formatMoney(row.totalCredits, row.currency)}</TableCell>
                    <TableCell>{formatMoney(row.totalPayments, row.currency)}</TableCell>
                    <TableCell>{formatMoney(row.netSpend, row.currency)}</TableCell>
                    <TableCell>{row.reviewCount}</TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <section className="card dashboardChartCard" aria-busy={loading}>
        <h2>Review queue</h2>
        <p className="muted">
          Recent flagged transactions from the current view so you can see what still
          needs cleanup.
        </p>
        <div className="tableWrap">
          <Table className="table">
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                {!currency && <TableHead>Currency</TableHead>}
                <TableHead>Merchant</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!loading && reviewQueueData.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={currency ? 5 : 6} className="emptyStateCell">
                    <p className="emptyState">
                      No flagged transactions in the current filters.
                    </p>
                  </TableCell>
                </TableRow>
              ) : null}
              {reviewQueueData.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>{row.date}</TableCell>
                    {!currency && <TableCell>{row.currency}</TableCell>}
                    <TableCell>{row.merchant}</TableCell>
                    <TableCell>{row.accountName}</TableCell>
                    <TableCell>{row.category ?? '(uncategorized)'}</TableCell>
                    <TableCell>{formatMoney(row.amount, row.currency)}</TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </div>
      </section>
    </div>
  )
}
