import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  BarChart,
  Bar,
} from 'recharts'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { SkeletonRow } from '@/components/ui/skeleton'
import { EmptyTableRow } from '@/components/ui/empty-state'
import { getJson } from '../../lib/api'
import { formatMoney } from '../../lib/formatMoney'

interface TopItem {
  name: string
  vendor: string
  totalCents: number
  count: number
  lastBoughtOn: string | null
}

interface BrandEntry {
  brand: string
  totalCents: number
}

interface AnalyzeResponse {
  topItems: TopItem[]
  byBrand: BrandEntry[]
  currencyUsed: string
  currencyOthers: string[]
}

interface TrendPoint {
  date: string
  unitPriceCents: number
}

interface TrendResponse {
  points: TrendPoint[]
  slopePerYear: number | null
  mixedUnits: boolean
}

function defaultDateRange(): { from: string; to: string } {
  const to = new Date()
  const from = new Date()
  from.setDate(from.getDate() - 90)
  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
  }
}

export function AnalyzeTab() {
  const { from: defaultFrom, to: defaultTo } = defaultDateRange()
  const [from, setFrom] = useState(defaultFrom)
  const [to, setTo] = useState(defaultTo)
  const [currency, setCurrency] = useState('')

  const [data, setData] = useState<AnalyzeResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [selectedItem, setSelectedItem] = useState<TopItem | null>(null)
  const [trend, setTrend] = useState<TrendResponse | null>(null)
  const [trendLoading, setTrendLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ from, to })
      if (currency) qs.set('currency', currency)
      const res = await getJson<AnalyzeResponse>(`/api/items/analyze?${qs}`)
      setData(res)
      if (!currency && res.currencyUsed) setCurrency(res.currencyUsed)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load analytics')
    } finally {
      setLoading(false)
    }
  }, [from, to, currency])

  useEffect(() => {
    void load()
  }, [load])

  async function loadTrend(item: TopItem) {
    setSelectedItem(item)
    setTrend(null)
    setTrendLoading(true)
    try {
      const qs = new URLSearchParams({ itemName: item.name, vendor: item.vendor, from, to })
      const res = await getJson<TrendResponse>(`/api/items/analyze/trend?${qs}`)
      setTrend(res)
    } catch {
      setTrend(null)
    } finally {
      setTrendLoading(false)
    }
  }

  const cur = data?.currencyUsed ?? currency ?? 'CAD'

  return (
    <div className="space-y-6 py-4">
      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">From</label>
          <input
            type="date"
            className="h-8 rounded border border-input bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">To</label>
          <input
            type="date"
            className="h-8 rounded border border-input bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
        {data && data.currencyOthers.length > 0 && (
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">Currency</label>
            <select
              className="h-8 rounded border border-input bg-background px-2 text-sm focus:outline-none"
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
            >
              <option value={data.currencyUsed}>{data.currencyUsed}</option>
              {data.currencyOthers.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      {data && data.currencyOthers.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Showing {data.currencyUsed} only.
        </p>
      )}

      {error && (
        <div className="space-y-2">
          <p className="text-sm text-destructive">Couldn't load analytics. Retry.</p>
          <Button size="sm" variant="outline" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      )}

      {!error && !loading && data && data.topItems.length === 0 && (
        <div className="space-y-2 py-8 text-center">
          <p className="font-semibold">No item-level data yet.</p>
          <p className="text-sm text-muted-foreground">Items appear here as you import receipts.</p>
          <Button size="sm" asChild>
            <Link to="/import">Go to import</Link>
          </Button>
        </div>
      )}

      {/* Panel 1: Top items by spend */}
      {(loading || (data && data.topItems.length > 0)) && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">Top items by spend</h3>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead>Vendor</TableHead>
                <TableHead className="text-right">Total spend</TableHead>
                <TableHead className="text-right"># Purchases</TableHead>
                <TableHead>Last bought</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <SkeletonRow cols={5} rows={5} />
              ) : (
                data?.topItems.map((item) => (
                  <TableRow
                    key={item.name + item.vendor}
                    className="cursor-pointer hover:bg-accent/30"
                    onClick={() => void loadTrend(item)}
                    aria-selected={selectedItem?.name === item.name && selectedItem?.vendor === item.vendor}
                  >
                    <TableCell className="font-medium">{item.name}</TableCell>
                    <TableCell className="text-muted-foreground">{item.vendor}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMoney(item.totalCents / 100, cur)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{item.count}</TableCell>
                    <TableCell className="text-muted-foreground">{item.lastBoughtOn ?? '—'}</TableCell>
                  </TableRow>
                ))
              )}
              {!loading && data?.topItems.length === 0 && (
                <EmptyTableRow cols={5} message="No items match this filter." />
              )}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Panel 3: Unit-price trend (shown after row click) */}
      {selectedItem && (
        <Card className="p-4 space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-semibold">
              Unit-price trend — {selectedItem.name}
            </h3>
            {trend && trend.slopePerYear !== null && trend.slopePerYear > 0.05 && (
              <Badge variant="destructive">
                Price up {Math.round(trend.slopePerYear * 100)}% / year
              </Badge>
            )}
            {trend?.mixedUnits && (
              <span className="text-xs text-muted-foreground">Mixed units; trend may be skewed.</span>
            )}
          </div>
          {trendLoading && <p className="text-sm text-muted-foreground">Loading trend…</p>}
          {trend && trend.points.length === 0 && (
            <p className="text-sm text-muted-foreground">No unit-price data for this item.</p>
          )}
          {trend && trend.points.length > 0 && (
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={trend.points} margin={{ top: 4, right: 8, bottom: 4, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis
                  tick={{ fontSize: 11 }}
                  tickFormatter={(v: number) => formatMoney(v / 100, cur)}
                />
                <Tooltip
                  formatter={(v: number) => [formatMoney(v / 100, cur), 'Unit price']}
                />
                <Line
                  type="monotone"
                  dataKey="unitPriceCents"
                  dot={{ r: 3 }}
                  strokeWidth={trend.points.length >= 3 ? 2 : 0}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </Card>
      )}

      {/* Panel 2: Spend by brand */}
      {(loading || (data && data.byBrand.length > 0)) && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">Spend by vendor</h3>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <ResponsiveContainer width="100%" height={Math.max(200, (data?.byBrand.length ?? 0) * 32 + 40)}>
              <BarChart
                data={data?.byBrand}
                layout="vertical"
                margin={{ top: 4, right: 16, bottom: 4, left: 8 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis
                  type="number"
                  tick={{ fontSize: 11 }}
                  tickFormatter={(v: number) => formatMoney(v / 100, cur)}
                />
                <YAxis type="category" dataKey="brand" tick={{ fontSize: 11 }} width={80} />
                <Tooltip
                  formatter={(v: number) => [formatMoney(v / 100, cur), 'Spend']}
                />
                <Bar dataKey="totalCents" fill="var(--primary)" radius={[0, 3, 3, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      )}
    </div>
  )
}
