import { useEffect, useMemo, useState } from 'react'
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
import { formatMoney } from '../lib/formatMoney'
import { summaryQueryString } from '../lib/summaryQuery'
import { getJson } from '../lib/api'

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
  netAmount: number
  transactionCount: number
}

type DashResp = { byCategory: Row[]; metricsByCurrency: CurrencyMetrics[] }

type MonthlyResp = {
  points: { month: string; currency: string; sumAmount: number }[]
}

const LINE_COLORS = [
  'var(--accent)',
  '#94a3b8',
  '#f59e0b',
  '#22c55e',
  '#8b5cf6',
  '#ec4899',
]

function toDateInputValue(d: Date): string {
  return d.toISOString().slice(0, 10)
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

export function DashboardPage() {
  const defaultRange = useMemo(() => getDefaultDashboardRange(), [])
  const [currency, setCurrency] = useState<string>('CAD')
  const [dateFrom, setDateFrom] = useState(defaultRange.from)
  const [dateTo, setDateTo] = useState(defaultRange.to)
  const [data, setData] = useState<DashResp | null>(null)
  const [previousMetricsByCurrency, setPreviousMetricsByCurrency] = useState<
    CurrencyMetrics[]
  >([])
  const [monthly, setMonthly] = useState<MonthlyResp | null>(null)
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
        const [d, m, prev] = await Promise.all([
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
        ])
        if (!cancelled) {
          setData(d)
          setMonthly(m)
          setPreviousMetricsByCurrency(prev?.metricsByCurrency ?? [])
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
  }, [summaryQs, previousRange, currency])

  const currencies = useMemo(() => {
    const s = new Set<string>()
    data?.byCategory.forEach((r) => s.add(r.currency))
    return Array.from(s).sort()
  }, [data])

  const chartData = useMemo(() => {
    const byCat = new Map<string, number>()
    for (const r of data?.byCategory ?? []) {
      if (currency && r.currency !== currency) continue
      const label = r.category ?? '(uncategorized)'
      byCat.set(label, (byCat.get(label) ?? 0) + r.sumAmount)
    }
    return Array.from(byCat.entries()).map(([name, total]) => ({ name, total }))
  }, [data, currency])

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

  const summaryStats = useMemo(() => {
    const metricRows = data?.metricsByCurrency ?? []
    const selected = metricRows.filter((r) => !currency || r.currency === currency)
    const prevSelected = previousMetricsByCurrency.filter(
      (r) => !currency || r.currency === currency
    )
    const spendTotal = selected.reduce((sum, row) => sum + row.totalSpend, 0)
    const creditTotal = selected.reduce((sum, row) => sum + row.totalCredits, 0)
    const netTotal = selected.reduce((sum, row) => sum + row.netAmount, 0)
    const txCount = selected.reduce((sum, row) => sum + row.transactionCount, 0)
    const prevSpendTotal = prevSelected.reduce((sum, row) => sum + row.totalSpend, 0)
    const prevCreditTotal = prevSelected.reduce((sum, row) => sum + row.totalCredits, 0)
    const prevNetTotal = prevSelected.reduce((sum, row) => sum + row.netAmount, 0)
    const prevTxCount = prevSelected.reduce((sum, row) => sum + row.transactionCount, 0)
    const singleCurrency = selected.length === 1 ? selected[0].currency : null
    const comparisonHint =
      previousRange == null
        ? 'Set both dates for period comparison.'
        : `${previousRange.from} to ${previousRange.to}`
    const spendDelta = spendTotal - prevSpendTotal
    const creditDelta = creditTotal - prevCreditTotal
    const netDelta = netTotal - prevNetTotal
    const txDelta = txCount - prevTxCount
    const formatDeltaMoney = (v: number): string => {
      const abs = Math.abs(v)
      const sign = v > 0 ? '+' : v < 0 ? '-' : ''
      if (singleCurrency == null) return `${sign}${abs.toFixed(2)}`
      return `${sign}${formatMoney(abs, singleCurrency)}`
    }
    const formatDeltaCount = (v: number): string =>
      `${v > 0 ? '+' : ''}${Math.trunc(v)}`

    return {
      spendLabel:
        singleCurrency != null
          ? formatMoney(spendTotal, singleCurrency)
          : `${selected.length} currencies`,
      creditsLabel:
        singleCurrency != null
          ? formatMoney(creditTotal, singleCurrency)
          : `${selected.length} currencies`,
      netLabel:
        singleCurrency != null
          ? formatMoney(netTotal, singleCurrency)
          : `${selected.length} currencies`,
      moneyHint:
        singleCurrency != null ? `In ${singleCurrency}` : 'Across selected currencies',
      txCount,
      spendDeltaLabel: formatDeltaMoney(spendDelta),
      creditsDeltaLabel: formatDeltaMoney(creditDelta),
      netDeltaLabel: formatDeltaMoney(netDelta),
      txDeltaLabel: formatDeltaCount(txDelta),
      comparisonHint,
      categoryCount: chartData.length,
      monthCount: monthlyChartData.length,
    }
  }, [
    data?.metricsByCurrency,
    previousMetricsByCurrency,
    previousRange,
    currency,
    chartData.length,
    monthlyChartData.length,
  ])

  const activeRangeLabel = useMemo(() => {
    if (!dateFrom && !dateTo) return 'All dates'
    if (dateFrom && dateTo) return `${dateFrom} to ${dateTo}`
    if (dateFrom) return `From ${dateFrom}`
    return `Up to ${dateTo}`
  }, [dateFrom, dateTo])

  return (
    <div className="page">
      <div className="dashboardHeader">
        <h1>Dashboard</h1>
        <p className="muted">
          Totals stay in each currency. Filter by currency and date range.
        </p>
      </div>
      {err && <span className="error">{err}</span>}
      {loading && <p className="muted">Loading dashboard…</p>}

      <section className="card dashboardFilters">
        <div className="row">
          <label>
            Currency{' '}
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
            >
              <option value="">All (category chart may mix currencies)</option>
              {currencies.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label>
            From{' '}
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
            />
          </label>
          <label>
            To{' '}
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
            />
          </label>
          {(currency || dateFrom || dateTo) && (
            <button
              type="button"
              onClick={() => {
                setCurrency('CAD')
                setDateFrom(defaultRange.from)
                setDateTo(defaultRange.to)
              }}
            >
              Clear filters
            </button>
          )}
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          Showing <strong>{currency || 'all currencies'}</strong> for{' '}
          <strong>{activeRangeLabel}</strong>.
        </p>
      </section>

      <section className="dashboardStats" aria-busy={loading}>
        <article className="card statCard">
          <p className="statLabel">Total spend</p>
          <p className="statValue">{summaryStats.spendLabel}</p>
          <p className="muted statHint">
            Charges only (absolute values). {summaryStats.moneyHint}
          </p>
          <p className="muted statDelta">
            vs previous period: {summaryStats.spendDeltaLabel}
          </p>
        </article>
        <article className="card statCard">
          <p className="statLabel">Credits / refunds</p>
          <p className="statValue">{summaryStats.creditsLabel}</p>
          <p className="muted statHint">Positive transaction amounts.</p>
          <p className="muted statDelta">
            vs previous period: {summaryStats.creditsDeltaLabel}
          </p>
        </article>
        <article className="card statCard">
          <p className="statLabel">Net cashflow</p>
          <p className="statValue">{summaryStats.netLabel}</p>
          <p className="muted statHint">Signed sum: credits + charges.</p>
          <p className="muted statDelta">
            vs previous period: {summaryStats.netDeltaLabel}
          </p>
        </article>
        <article className="card statCard">
          <p className="statLabel">Transactions</p>
          <p className="statValue">{summaryStats.txCount}</p>
          <p className="muted statHint">Rows in current filters</p>
          <p className="muted statDelta">
            vs previous period: {summaryStats.txDeltaLabel}
          </p>
        </article>
        <article className="card statCard">
          <p className="statLabel">Categories</p>
          <p className="statValue">{summaryStats.categoryCount}</p>
          <p className="muted statHint">Shown in category chart</p>
        </article>
        <article className="card statCard">
          <p className="statLabel">Months</p>
          <p className="statValue">{summaryStats.monthCount}</p>
          <p className="muted statHint">Shown in monthly trend</p>{' '}
          <p className="muted statDelta">{summaryStats.comparisonHint}</p>
        </article>
      </section>

      <section className="card dashboardChartCard" aria-busy={loading}>
        <h2>Net by category</h2>
        <p className="muted">
          Signed totals by category (charges negative, credits positive).
        </p>
        <div className="chartWrap">
          {!loading && chartData.length === 0 ? (
            <div>
              <p className="emptyState">
                No category totals for these filters. Your transactions may be in a
                different currency or outside this date window.
              </p>
              <div className="row" style={{ marginTop: '0.5rem', marginBottom: 0 }}>
                {currency ? (
                  <button type="button" onClick={() => setCurrency('')}>
                    Show all currencies
                  </button>
                ) : null}
                {(dateFrom || dateTo) && (
                  <button
                    type="button"
                    onClick={() => {
                      setDateFrom('')
                      setDateTo('')
                    }}
                  >
                    Show all dates
                  </button>
                )}
              </div>
            </div>
          ) : !loading ? (
            <ResponsiveContainer width="100%" height={320}>
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="name" />
                <YAxis />
                <Tooltip
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
                <Legend />
                <Bar dataKey="total" name="Amount" fill="var(--accent)" />
              </BarChart>
            </ResponsiveContainer>
          ) : null}
        </div>
      </section>

      <section className="card dashboardChartCard">
        <h2>Net by month</h2>
        <p className="muted">
          One line per currency using signed monthly totals.
        </p>
        <div className="chartWrap">
          {!loading && monthlyChartData.length === 0 ? (
            <p className="muted">No transactions in this range.</p>
          ) : !loading ? (
            <ResponsiveContainer width="100%" height={320}>
              <LineChart data={monthlyChartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="month" />
                <YAxis />
                <Tooltip
                  formatter={(value, name) => {
                    const v = typeof value === 'number' ? value : Number(value)
                    if (!Number.isFinite(v)) return ''
                    return formatMoney(v, String(name))
                  }}
                />
                <Legend />
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
          ) : null}
        </div>
      </section>
    </div>
  )
}
