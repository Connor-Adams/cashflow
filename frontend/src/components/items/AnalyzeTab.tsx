import { useCallback, useEffect, useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { getJson } from '@/lib/api'
import { formatMoney } from '@/lib/formatMoney'

type TopItem = {
  name: string
  brand: string | null
  totalCents: number
  count: number
  lastBoughtOn: string | null
}

type BrandRow = { brand: string; totalCents: number }

type AnalyzeResponse = {
  topItems: TopItem[]
  byBrand: BrandRow[]
  currencyUsed: string
  currencyOthers: string[]
}

type TrendPoint = { date: string; unitPriceCents: number | null }
type TrendResponse = {
  points: TrendPoint[]
  slopePerYear: number | null
  mixedUnits: boolean
}

function nDaysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

export function AnalyzeTab() {
  const [from, setFrom] = useState(nDaysAgo(90))
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10))
  const [data, setData] = useState<AnalyzeResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedItem, setSelectedItem] = useState<TopItem | null>(null)
  const [trend, setTrend] = useState<TrendResponse | null>(null)
  const [trendLoading, setTrendLoading] = useState(false)

  const loadAnalyze = useCallback(async () => {
    setLoading(true)
    setError(null)
    setSelectedItem(null)
    setTrend(null)
    try {
      const params = new URLSearchParams({ from, to })
      const resp = await getJson<AnalyzeResponse>(`/api/items/analyze?${params}`)
      setData(resp)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load analysis')
    } finally {
      setLoading(false)
    }
  }, [from, to])

  useEffect(() => {
    void loadAnalyze()
  }, [loadAnalyze])

  async function loadTrend(item: TopItem) {
    setSelectedItem(item)
    setTrendLoading(true)
    try {
      const params = new URLSearchParams({ itemName: item.name, from, to })
      if (item.brand) params.set('brand', item.brand)
      const resp = await getJson<TrendResponse>(`/api/items/analyze/trend?${params}`)
      setTrend(resp)
    } catch {
      setTrend(null)
    } finally {
      setTrendLoading(false)
    }
  }

  const currency = data?.currencyUsed ?? 'CAD'

  return (
    <div className="space-y-4">
      {/* Date range filter */}
      <div className="flex flex-wrap gap-3 items-end">
        <div>
          <Label htmlFor="analyze-from">From</Label>
          <Input
            id="analyze-from"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            style={{ width: 150 }}
          />
        </div>
        <div>
          <Label htmlFor="analyze-to">To</Label>
          <Input
            id="analyze-to"
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            style={{ width: 150 }}
          />
        </div>
        <Button variant="outline" onClick={() => void loadAnalyze()}>Apply</Button>
      </div>

      {error && <p className="text-destructive text-sm">{error}</p>}

      {/* Panel 1: Top items table */}
      <Card className="p-0">
        <div className="p-4 border-b">
          <h3 className="font-semibold">Top items by spend</h3>
          <p className="text-sm text-muted-foreground">Click a row to see its price trend.</p>
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead>Brand</TableHead>
                <TableHead>Total spent</TableHead>
                <TableHead>Count</TableHead>
                <TableHead>Last bought</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 5 }).map((__, j) => (
                      <TableCell key={j}><Skeleton className="h-4 w-20" /></TableCell>
                    ))}
                  </TableRow>
                ))
              ) : !data || data.topItems.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground py-6">
                    No items found in this date range.
                  </TableCell>
                </TableRow>
              ) : (
                data.topItems.map((item, i) => (
                  <TableRow
                    key={i}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => void loadTrend(item)}
                    data-selected={selectedItem?.name === item.name && selectedItem?.brand === item.brand}
                    style={selectedItem?.name === item.name ? { background: 'var(--muted)' } : undefined}
                  >
                    <TableCell className="font-medium">{item.name}</TableCell>
                    <TableCell>{item.brand ?? <span className="text-muted-foreground">—</span>}</TableCell>
                    <TableCell>{formatMoney(item.totalCents / 100, currency)}</TableCell>
                    <TableCell>{item.count}</TableCell>
                    <TableCell>{item.lastBoughtOn ?? '—'}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </Card>

      {/* Panel 2: Brand bar chart */}
      {data && data.byBrand.length > 0 && (
        <Card className="p-4">
          <h3 className="font-semibold mb-3">Spend by brand</h3>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={data.byBrand} margin={{ left: 10, right: 10, top: 8, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="brand" tick={{ fontSize: 12 }} />
              <YAxis tickFormatter={(v: number) => `${(v / 100).toFixed(0)}`} tick={{ fontSize: 12 }} />
              <Tooltip formatter={(v: number) => formatMoney(v / 100, currency)} />
              <Bar dataKey="totalCents" name="Total spent" fill="var(--primary)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
      )}

      {/* Panel 3: Price trend (shown when a row is selected) */}
      {selectedItem && (
        <Card className="p-4">
          <h3 className="font-semibold mb-1">
            Price trend: {selectedItem.name}
            {selectedItem.brand ? ` (${selectedItem.brand})` : ''}
          </h3>
          {trendLoading ? (
            <Skeleton className="h-48 w-full" />
          ) : !trend || trend.points.length === 0 ? (
            <p className="text-sm text-muted-foreground">No unit price data available for this item.</p>
          ) : (
            <>
              {trend.mixedUnits && (
                <p className="text-xs text-amber-600 mb-2">Mixed units detected — trend may not be meaningful.</p>
              )}
              {trend.slopePerYear != null && (
                <p className="text-sm mb-2">
                  Price trend: <span className={trend.slopePerYear > 0 ? 'text-destructive' : 'text-emerald-600'}>
                    {trend.slopePerYear > 0 ? '+' : ''}{(trend.slopePerYear * 100).toFixed(1)}% / year
                  </span>
                </p>
              )}
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={trend.points} margin={{ left: 10, right: 10, top: 8, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                  <YAxis tickFormatter={(v: number) => `${(v / 100).toFixed(2)}`} tick={{ fontSize: 11 }} />
                  <Tooltip formatter={(v: number) => formatMoney(v / 100, currency)} />
                  <Line
                    type="monotone"
                    dataKey="unitPriceCents"
                    name="Unit price"
                    stroke="var(--primary)"
                    strokeWidth={2}
                    dot={{ r: 3 }}
                    connectNulls
                  />
                </LineChart>
              </ResponsiveContainer>
            </>
          )}
        </Card>
      )}
    </div>
  )
}
