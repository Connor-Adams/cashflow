import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { EmptyTableRow } from '@/components/ui/empty-state'
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
import { getJson, postJson } from '../lib/api'
import { formatMoney } from '../lib/formatMoney'
import type { PortfolioSummary } from '../types/api'

const STALE_QUOTE_THRESHOLD_MS = 60 * 60 * 1000 // 1 hour

function formatRelativeTime(from: number, now: number): string {
  const diffMs = Math.max(0, now - from)
  const minutes = Math.floor(diffMs / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

type RefreshResult = {
  provider: string
  results: Array<{
    symbol: string
    status: string
    price?: number
    fetchedAt?: string
    error?: string
  }>
}

export function PortfolioPage() {
  const [data, setData] = useState<PortfolioSummary | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  // Freshness anchor for the relative "Last refreshed" label. We start from the
  // latest per-holding latestPrice.fetchedAt when the query resolves, but fall
  // back to the resolution timestamp so the label is never empty after a fetch.
  const [quotesAsOf, setQuotesAsOf] = useState<number | null>(null)
  const [now, setNow] = useState<number>(() => Date.now())

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const summary = await getJson<PortfolioSummary>('/api/portfolio')
      setData(summary)
      const fetchedAts = summary.holdings
        .map((h) => h.latestPrice?.fetchedAt)
        .filter((v): v is string => typeof v === 'string')
        .map((v) => Date.parse(v))
        .filter((n) => Number.isFinite(n))
      const latest = fetchedAts.length > 0 ? Math.max(...fetchedAts) : Date.now()
      setQuotesAsOf(latest)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load portfolio')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Tick once a minute so the relative label re-renders without a full reload.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60000)
    return () => window.clearInterval(id)
  }, [])

  const freshnessLabel = useMemo(() => {
    if (quotesAsOf == null) return null
    return formatRelativeTime(quotesAsOf, now)
  }, [quotesAsOf, now])

  const isStale =
    quotesAsOf != null && now - quotesAsOf > STALE_QUOTE_THRESHOLD_MS

  async function refreshPrices() {
    setRefreshing(true)
    setErr(null)
    setMessage(null)
    try {
      const out = await postJson<RefreshResult>('/api/portfolio/prices/refresh', {})
      const refreshed = out.results.filter((row) => row.status === 'refreshed').length
      const cached = out.results.filter((row) => row.status === 'cached').length
      const failed = out.results.filter((row) => row.status === 'error').length
      setMessage(`Quotes: ${refreshed} refreshed, ${cached} cached${failed ? `, ${failed} failed` : ''}.`)
      await load()
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Quote refresh failed')
    } finally {
      setRefreshing(false)
    }
  }

  const accountsById = new Map((data?.accounts ?? []).map((account) => [account.id, account]))

  return (
    <div className="page">
      <PageHeader
        title="Portfolio"
        description="Investment positions, broker cost basis, market values, and recent activity."
        actions={
          <div className="flex flex-col items-end gap-1">
            <Button type="button" onClick={() => void refreshPrices()} disabled={refreshing}>
              <RefreshCw aria-hidden="true" />
              {refreshing ? 'Refreshing…' : 'Refresh quotes'}
            </Button>
            {freshnessLabel ? (
              <span
                className="text-xs"
                style={{
                  color: isStale
                    ? 'var(--accent-warm)'
                    : 'var(--muted-foreground)',
                }}
              >
                Last refreshed: {freshnessLabel}
              </span>
            ) : null}
          </div>
        }
      />

      {err && <p className="error">{err}</p>}
      {message && <p className={message.includes('not configured') ? 'uploadMsg warn' : 'uploadMsg'}>{message}</p>}

      <section className="transactionsStats" aria-busy={loading}>
        {(data?.totalsByCurrency ?? []).map((total) => (
          <StatCard
            key={total.currency}
            label={total.currency}
            value={formatMoney(total.marketValue, total.currency)}
            hint="Current portfolio value"
          />
        ))}
        {data && data.totalsByCurrency.length === 0 && (
          <StatCard
            label="Holdings"
            value="0"
            hint="Import investment statements to populate this page"
          />
        )}
      </section>

      <Card className="transactionsTableCard">
        <div className="transactionsPanelHeader">
          <div>
            <h2>Holdings</h2>
            <p className="muted">
              Latest imported position per account and security. Live quotes override imported market value for current valuation.
            </p>
          </div>
        </div>
        <div className="transactionsTableWrap">
          <Table className="table transactionsTable">
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead>Symbol</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Qty</TableHead>
                <TableHead>Price</TableHead>
                <TableHead>Market value</TableHead>
                <TableHead>Cost basis</TableHead>
                <TableHead>Unrealized</TableHead>
                <TableHead>As of</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.holdings ?? []).map((holding) => (
                <TableRow key={holding.id}>
                  <TableCell>{accountsById.get(holding.accountId)?.name ?? holding.accountId}</TableCell>
                  <TableCell>{holding.security?.symbol ?? '—'}</TableCell>
                  <TableCell>{holding.security?.name ?? '—'}</TableCell>
                  <TableCell>{holding.quantity}</TableCell>
                  <TableCell>
                    {holding.latestPrice
                      ? formatMoney(holding.latestPrice.price ?? 0, holding.latestPrice.currency)
                      : holding.price != null
                        ? formatMoney(holding.price, holding.currency)
                        : '—'}
                  </TableCell>
                  <TableCell>{formatMoney(holding.marketValue, holding.currency)}</TableCell>
                  <TableCell>{holding.costBasis != null ? formatMoney(holding.costBasis, holding.currency) : '—'}</TableCell>
                  <TableCell>{holding.unrealizedGainLoss != null ? formatMoney(holding.unrealizedGainLoss, holding.currency) : '—'}</TableCell>
                  <TableCell>{holding.statementDate}</TableCell>
                </TableRow>
              ))}
              {data && data.holdings.length === 0 && (
                <EmptyTableRow
                  colSpan={9}
                  title="No holdings imported yet."
                  description="Import an investment statement to populate this table."
                />
              )}
            </TableBody>
          </Table>
        </div>
      </Card>

      <Card className="transactionsTableCard">
        <div className="transactionsPanelHeader">
          <div>
            <h2>Recent investment activity</h2>
            <p className="muted">Trades, dividends, fees, transfers, and other imported brokerage rows.</p>
          </div>
        </div>
        <div className="transactionsTableWrap">
          <Table className="table transactionsTable">
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Security</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Qty</TableHead>
                <TableHead>Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.recentActivities ?? []).map((activity) => (
                <TableRow key={activity.id}>
                  <TableCell>{activity.tradeDate}</TableCell>
                  <TableCell>{accountsById.get(activity.accountId)?.name ?? activity.accountId}</TableCell>
                  <TableCell>{activity.activityType}</TableCell>
                  <TableCell>{activity.security?.symbol ?? '—'}</TableCell>
                  <TableCell>{activity.description}</TableCell>
                  <TableCell>{activity.quantity ?? '—'}</TableCell>
                  <TableCell>{activity.amount != null ? formatMoney(activity.amount, activity.currency) : '—'}</TableCell>
                </TableRow>
              ))}
              {data && data.recentActivities.length === 0 && (
                <EmptyTableRow
                  colSpan={7}
                  title="No investment activity imported yet."
                  description="Trades, dividends, fees, and transfers appear here after import."
                />
              )}
            </TableBody>
          </Table>
        </div>
      </Card>
    </div>
  )
}
