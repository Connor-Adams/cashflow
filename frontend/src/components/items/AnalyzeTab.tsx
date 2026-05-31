import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { AlertTriangle, RefreshCw, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { getJson } from '@/lib/api'
import { formatMoney } from '@/lib/formatMoney'

// ── Types ─────────────────────────────────────────────────────────────────────

type TopItem = {
  name: string
  brand: string
  totalCents: number
  count: number
  lastBoughtOn: string
}

type BrandSpend = {
  brand: string
  totalCents: number
}

type AnalyzeResult = {
  topItems: TopItem[]
  byBrand: BrandSpend[]
  currencyUsed: string
  currencyOthers: string[]
}

type TrendPoint = {
  date: string
  unitPriceCents: number
}

type TrendResult = {
  points: TrendPoint[]
  slopePerYear: number | null
  mixedUnits: boolean
}

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_DAYS = 90

function defaultFrom(): string {
  const d = new Date()
  d.setDate(d.getDate() - DEFAULT_DAYS)
  return d.toISOString().slice(0, 10)
}

function defaultTo(): string {
  return new Date().toISOString().slice(0, 10)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(s: string): string {
  if (!s) return ''
  const d = new Date(s + 'T00:00:00')
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' })
}

function buildQuery(params: Record<string, string | undefined>): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v) p.set(k, v)
  }
  const s = p.toString()
  return s ? `?${s}` : ''
}

// ── Trend panel ───────────────────────────────────────────────────────────────

function TrendPanel({
  item,
  currency,
  from,
  to,
  onClose,
}: {
  item: TopItem
  currency: string
  from: string
  to: string
  onClose: () => void
}) {
  const [data, setData] = useState<TrendResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    const qs = buildQuery({ itemName: item.name, brand: item.brand, from, to })
    getJson<TrendResult>(`/api/items/analyze/trend${qs}`)
      .then((r) => { if (!cancelled) { setData(r); setLoading(false) } })
      .catch(() => { if (!cancelled) { setError('Failed to load trend'); setLoading(false) } })
    return () => { cancelled = true }
  }, [item.name, item.brand, from, to])

  const slopePct = data?.slopePerYear != null
    ? Math.round(data.slopePerYear * 100)
    : null

  return (
    <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h4 className="font-semibold text-sm">Unit-price trend</h4>
          <p className="text-xs text-muted-foreground">{item.name} · {item.brand}</p>
        </div>
        <div className="flex items-center gap-2">
          {slopePct != null && slopePct > 5 && (
            <Badge variant="destructive" className="flex items-center gap-1 text-xs">
              <AlertTriangle className="h-3 w-3" />
              Price up {slopePct}% / year
            </Badge>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 hover:bg-accent"
            aria-label="Close trend"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {loading && (
        <div className="h-40 flex items-center justify-center text-sm text-muted-foreground">
          Loading…
        </div>
      )}
      {error && (
        <div className="text-sm text-destructive">{error}</div>
      )}
      {!loading && !error && data && data.points.length === 0 && (
        <div className="text-sm text-muted-foreground">No unit-price data for this item.</div>
      )}
      {!loading && !error && data && data.points.length > 0 && (
        <>
          <ResponsiveContainer width="100%" height={160}>
            <LineChart data={data.points} margin={{ top: 4, right: 8, left: 8, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 10 }}
                tickFormatter={formatDate}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fontSize: 10 }}
                tickFormatter={(v: number) =>
                  formatMoney(v / 100, currency)
                }
                width={64}
              />
              <Tooltip
                formatter={(v: number) => formatMoney(v / 100, currency)}
                labelFormatter={formatDate}
              />
              <Line
                type="monotone"
                dataKey="unitPriceCents"
                dot={{ r: 3 }}
                strokeWidth={2}
                className="stroke-primary"
              />
              {data.points.length >= 3 && data.slopePerYear != null && (
                <ReferenceLine
                  stroke="var(--color-muted-foreground)"
                  strokeDasharray="4 2"
                  segment={(() => {
                    const first = data.points[0]!
                    const last = data.points[data.points.length - 1]!
                    const t0 = new Date(first.date).getTime()
                    const t1 = new Date(last.date).getTime()
                    const days = (t1 - t0) / 86400000
                    const slopePerDay = data.slopePerYear! * first.unitPriceCents / 365
                    return [
                      { x: first.date, y: first.unitPriceCents },
                      { x: last.date, y: first.unitPriceCents + slopePerDay * days },
                    ]
                  })()}
                />
              )}
            </LineChart>
          </ResponsiveContainer>
          {data.mixedUnits && (
            <p className="text-xs text-muted-foreground italic">
              Mixed units; trend may be skewed.
            </p>
          )}
        </>
      )}
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────

export function AnalyzeTab() {
  const [from, setFrom] = useState(defaultFrom)
  const [to, setTo] = useState(defaultTo)
  const [vendorFilter, setVendorFilter] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')

  const [data, setData] = useState<AnalyzeResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedItem, setSelectedItem] = useState<TopItem | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const qs = buildQuery({
      from,
      to,
      vendors: vendorFilter || undefined,
      categories: categoryFilter || undefined,
    })
    try {
      const r = await getJson<AnalyzeResult>(`/api/items/analyze${qs}`)
      setData(r)
    } catch {
      setError("Couldn't load analytics.")
    } finally {
      setLoading(false)
    }
  }, [from, to, vendorFilter, categoryFilter])

  useEffect(() => { void load() }, [load])

  const hasFilters = vendorFilter || categoryFilter

  const clearFilters = useCallback(() => {
    setVendorFilter('')
    setCategoryFilter('')
    setSelectedItem(null)
  }, [])

  const isEmpty = !loading && !error && data &&
    data.topItems.length === 0 && data.byBrand.length === 0

  const currency = data?.currencyUsed ?? 'CAD'

  // Format money from cents for recharts tooltips
  const fmtCents = useCallback(
    (cents: number) => formatMoney(cents / 100, currency),
    [currency]
  )

  const barData = useMemo(
    () => data?.byBrand.map((b) => ({ brand: b.brand, spend: b.totalCents })) ?? [],
    [data]
  )

  return (
    <div className="space-y-6">
      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-end">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-muted-foreground">Date range</label>
          <div className="flex items-center gap-1">
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="rounded-md border border-input bg-background px-2 py-1 text-sm shadow-sm"
            />
            <span className="text-muted-foreground text-xs">to</span>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="rounded-md border border-input bg-background px-2 py-1 text-sm shadow-sm"
            />
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-muted-foreground">Merchant</label>
          <input
            type="text"
            placeholder="e.g. amazon"
            value={vendorFilter}
            onChange={(e) => setVendorFilter(e.target.value)}
            className="rounded-md border border-input bg-background px-2 py-1 text-sm shadow-sm w-36"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-muted-foreground">Category</label>
          <input
            type="text"
            placeholder="e.g. groceries"
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="rounded-md border border-input bg-background px-2 py-1 text-sm shadow-sm w-36"
          />
        </div>
        <Button size="sm" variant="outline" onClick={() => void load()}>
          <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
          Refresh
        </Button>
      </div>

      {data?.currencyOthers && data.currencyOthers.length > 0 && (
        <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-950/20 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          Showing {currency} only. Other currencies detected: {data.currencyOthers.join(', ')}.
        </div>
      )}

      {loading && (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-32 rounded-lg border bg-muted/50 animate-pulse" />
          ))}
        </div>
      )}

      {error && !loading && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive flex items-center justify-between">
          <span>{error} <button type="button" className="underline" onClick={() => void load()}>Retry</button></span>
        </div>
      )}

      {isEmpty && (
        <div className="rounded-lg border p-8 text-center space-y-3">
          <p className="font-semibold">No item-level data yet.</p>
          <p className="text-sm text-muted-foreground">Items appear here as you import receipts.</p>
          {hasFilters ? (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">No items match this filter.</p>
              <Button size="sm" variant="outline" onClick={clearFilters}>
                <X className="h-3.5 w-3.5 mr-1.5" />
                Clear filters
              </Button>
            </div>
          ) : (
            <Link
              to="/import"
              className="inline-flex items-center rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium shadow-sm hover:bg-accent"
            >
              Go to import
            </Link>
          )}
        </div>
      )}

      {!loading && !error && data && data.topItems.length > 0 && (
        <>
          {/* Panel 1: Top items */}
          <div className="rounded-lg border overflow-hidden">
            <div className="px-4 py-3 border-b bg-muted/30">
              <h3 className="font-semibold text-sm">Top items by spend</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="px-4 py-2 text-left font-medium">Item</th>
                    <th className="px-4 py-2 text-left font-medium">Merchant</th>
                    <th className="px-4 py-2 text-right font-medium">Total spend</th>
                    <th className="px-4 py-2 text-right font-medium"># Purchases</th>
                    <th className="px-4 py-2 text-right font-medium">Last bought</th>
                  </tr>
                </thead>
                <tbody>
                  {data.topItems.map((item, i) => {
                    const isSelected =
                      selectedItem?.name === item.name &&
                      selectedItem?.brand === item.brand
                    return (
                      <>
                        <tr
                          key={`${item.name}-${item.brand}-${i}`}
                          className={`border-b last:border-0 cursor-pointer transition-colors hover:bg-muted/40 ${isSelected ? 'bg-muted/60' : ''}`}
                          onClick={() =>
                            setSelectedItem(isSelected ? null : item)
                          }
                        >
                          <td className="px-4 py-2.5 font-medium max-w-[200px] truncate">
                            {item.name}
                          </td>
                          <td className="px-4 py-2.5 text-muted-foreground">{item.brand}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums">
                            {formatMoney(item.totalCents / 100, currency)}
                          </td>
                          <td className="px-4 py-2.5 text-right tabular-nums">{item.count}</td>
                          <td className="px-4 py-2.5 text-right text-muted-foreground">
                            {formatDate(item.lastBoughtOn)}
                          </td>
                        </tr>
                        {isSelected && (
                          <tr key={`trend-${item.name}-${item.brand}`}>
                            <td colSpan={5} className="px-4 pb-3">
                              <TrendPanel
                                item={item}
                                currency={currency}
                                from={from}
                                to={to}
                                onClose={() => setSelectedItem(null)}
                              />
                            </td>
                          </tr>
                        )}
                      </>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {hasFilters && data.topItems.length === 0 && (
              <div className="px-4 py-6 text-center text-sm text-muted-foreground space-y-2">
                <p>No items match this filter.</p>
                <Button size="sm" variant="outline" onClick={clearFilters}>
                  <X className="h-3.5 w-3.5 mr-1.5" />
                  Clear filters
                </Button>
              </div>
            )}
          </div>

          {/* Panel 2: Spend by brand */}
          {data.byBrand.length > 0 && (
            <div className="rounded-lg border overflow-hidden">
              <div className="px-4 py-3 border-b bg-muted/30">
                <h3 className="font-semibold text-sm">Spend by brand</h3>
              </div>
              <div className="p-4">
                <ResponsiveContainer width="100%" height={Math.max(160, data.byBrand.length * 28)}>
                  <BarChart
                    data={barData}
                    layout="vertical"
                    margin={{ top: 4, right: 16, left: 8, bottom: 4 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} className="stroke-border" />
                    <XAxis
                      type="number"
                      tick={{ fontSize: 10 }}
                      tickFormatter={fmtCents}
                    />
                    <YAxis
                      type="category"
                      dataKey="brand"
                      tick={{ fontSize: 11 }}
                      width={96}
                    />
                    <Tooltip formatter={fmtCents} labelFormatter={(l) => `Brand: ${l}`} />
                    <Bar dataKey="spend" radius={[0, 3, 3, 0]} className="fill-primary" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
