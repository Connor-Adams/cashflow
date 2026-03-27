import { useEffect, useMemo, useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { getJson } from '../lib/api'

type Row = {
  currency: string
  category: string | null
  sumAmount: number
  finalBusiness: boolean
  finalSplitType: string
}

type DashResp = { byCategory: Row[] }

export function DashboardPage() {
  const [currency, setCurrency] = useState<string>('')
  const [data, setData] = useState<DashResp | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const q = currency ? `?currency=${encodeURIComponent(currency)}` : ''
        const d = await getJson<DashResp>(`/api/summary/dashboard${q}`)
        if (!cancelled) setData(d)
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : 'Error')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [currency])

  const currencies = useMemo(() => {
    const s = new Set<string>()
    data?.byCategory.forEach((r) => s.add(r.currency))
    return Array.from(s).sort()
  }, [data])

  const chartData = useMemo(() => {
    const byCat = new Map<string, number>()
    for (const r of data?.byCategory ?? []) {
      const label = r.category ?? '(uncategorized)'
      byCat.set(label, (byCat.get(label) ?? 0) + r.sumAmount)
    }
    return Array.from(byCat.entries()).map(([name, total]) => ({ name, total }))
  }, [data])

  return (
    <div className="page">
      <h1>Dashboard</h1>
      <p className="muted">
        Totals stay in each currency. Pick a currency to filter charts.
      </p>
      {err && <span className="error">{err}</span>}
      <div className="row">
        <label>
          Currency{' '}
          <select
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
          >
            <option value="">All (chart mixes labels only)</option>
            {currencies.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="chartWrap">
        <h2>Spend by category</h2>
        <ResponsiveContainer width="100%" height={320}>
          <BarChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="name" />
            <YAxis />
            <Tooltip />
            <Legend />
            <Bar dataKey="total" name="Amount" fill="var(--accent)" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
