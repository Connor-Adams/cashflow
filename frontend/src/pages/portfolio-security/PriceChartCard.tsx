import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { getJson } from '../../lib/api'
import { getAppConfig } from '../../lib/appConfig'
import { formatMoney } from '../../lib/formatMoney'
import type { PortfolioSecurityPrices } from '../../types/api'

const RANGES: ReadonlyArray<{ key: PortfolioSecurityPrices['range']; label: string }> = [
  { key: '1m', label: '1M' },
  { key: '3m', label: '3M' },
  { key: '1y', label: '1Y' },
  { key: '5y', label: '5Y' },
  { key: 'all', label: 'All' },
]

const POLL_INTERVAL_MS = 5000
const POLL_MAX_ATTEMPTS = 24

export type PriceChartCardProps = {
  securityId: number
  currency: string
}

export function PriceChartCard({ securityId, currency }: PriceChartCardProps) {
  const quoteProviderConfigured =
    getAppConfig()?.quoteProviderConfigured ?? false
  const [range, setRange] = useState<PortfolioSecurityPrices['range']>('1y')
  const [data, setData] = useState<PortfolioSecurityPrices | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const pollAttemptsRef = useRef(0)

  const fetchData = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const res = await getJson<PortfolioSecurityPrices>(
        `/api/portfolio/security/${securityId}/prices?range=${range}`,
      )
      setData(res)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load price history')
    } finally {
      setLoading(false)
    }
  }, [securityId, range])

  useEffect(() => {
    if (!quoteProviderConfigured) return
    pollAttemptsRef.current = 0
    void fetchData()
  }, [fetchData, quoteProviderConfigured])

  useEffect(() => {
    if (!data) return
    if (data.backfill.status !== 'never' && data.backfill.status !== 'in_progress') return
    if (pollAttemptsRef.current >= POLL_MAX_ATTEMPTS) return
    const id = window.setTimeout(() => {
      pollAttemptsRef.current += 1
      void fetchData()
    }, POLL_INTERVAL_MS)
    return () => window.clearTimeout(id)
  }, [data, fetchData])

  if (!quoteProviderConfigured) {
    return (
      <Card>
        <div className="transactionsPanelHeader">
          <div>
            <h2 className="text-base">Price history</h2>
          </div>
        </div>
        <p className="muted">Quote provider is not configured.</p>
      </Card>
    )
  }

  const chartRows = data?.rows.map((r) => ({ date: r.date, close: r.adjClose })) ?? []
  const buyDots = data?.trades
    .filter((t) => t.type === 'buy')
    .map((t) => ({ date: t.date, close: t.price ?? null })) ?? []
  const sellDots = data?.trades
    .filter((t) => t.type === 'sell')
    .map((t) => ({ date: t.date, close: t.price ?? null })) ?? []

  return (
    <Card>
      <div className="transactionsPanelHeader">
        <div>
          <h2 className="text-base">Price history</h2>
          <p className="muted">
            Adjusted close. Buys in green, sells in red. Source: Yahoo Finance.
          </p>
        </div>
        <div className="flex gap-1">
          {RANGES.map((r) => (
            <Button
              key={r.key}
              type="button"
              variant={range === r.key ? 'default' : 'outline'}
              onClick={() => setRange(r.key)}
            >
              {r.label}
            </Button>
          ))}
        </div>
      </div>

      <BackfillBanner status={data?.backfill.status} loading={loading} />

      {err && <p className="error">{err}</p>}

      {chartRows.length === 0 ? (
        <p className="muted">No price history yet for this security.</p>
      ) : (
        <div style={{ width: '100%', height: 320 }}>
          <ResponsiveContainer>
            <LineChart data={chartRows}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} domain={['auto', 'auto']} />
              <Tooltip
                formatter={(value) => {
                  const v = typeof value === 'number' ? value : Number(value)
                  return Number.isFinite(v) ? formatMoney(v, currency) : ''
                }}
              />
              <Line
                type="monotone"
                dataKey="close"
                stroke="var(--chart-line-1)"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
              <Scatter data={buyDots} fill="var(--accent-positive)" />
              <Scatter data={sellDots} fill="var(--accent-warm)" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  )
}

function BackfillBanner({
  status,
  loading,
}: {
  status: string | undefined
  loading: boolean
}) {
  if (status === 'never' || status === 'in_progress') {
    return (
      <p className="muted text-sm" aria-live="polite">
        History loading… (auto-fetching in background){loading ? '' : ' — checking again shortly'}
      </p>
    )
  }
  if (status === 'rate_limited') {
    return (
      <p className="uploadMsg warn text-sm">
        Quote provider is rate-limiting us — retry shortly.
      </p>
    )
  }
  return null
}
