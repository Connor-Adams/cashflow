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

type DashResp = { byCategory: Row[] }

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

export function DashboardPage() {
  const [currency, setCurrency] = useState<string>('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [data, setData] = useState<DashResp | null>(null)
  const [monthly, setMonthly] = useState<MonthlyResp | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const summaryQs = useMemo(
    () => summaryQueryString({ currency, dateFrom, dateTo }),
    [currency, dateFrom, dateTo]
  )

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        setErr(null)
        const [d, m] = await Promise.all([
          getJson<DashResp>(`/api/summary/dashboard${summaryQs}`),
          getJson<MonthlyResp>(`/api/summary/monthly${summaryQs}`),
        ])
        if (!cancelled) {
          setData(d)
          setMonthly(m)
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : 'Error')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [summaryQs])

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

  return (
    <div className="page">
      <h1>Dashboard</h1>
      <p className="muted">
        Totals stay in each currency. Filter by currency and/or date range.
      </p>
      {err && <span className="error">{err}</span>}
      <div className="row">
        <label>
          Currency{' '}
          <select
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
          >
            <option value="">All (chart mixes categories across currencies)</option>
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
      </div>
      <div className="chartWrap">
        <h2>Spend by category</h2>
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
      </div>

      <div className="chartWrap">
        <h2>Spend by month</h2>
        <p className="muted">
          One line per currency (totals include credits and debits as stored).
        </p>
        {monthlyChartData.length === 0 ? (
          <p className="muted">No transactions in this range.</p>
        ) : (
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
        )}
      </div>
    </div>
  )
}
