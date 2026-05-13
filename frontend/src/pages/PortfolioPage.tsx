import { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { getJson, postJson } from '../lib/api'
import { formatMoney } from '../lib/formatMoney'
import type { PortfolioSummary } from '../types/api'

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

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      setData(await getJson<PortfolioSummary>('/api/portfolio'))
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load portfolio')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

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
      <div className="transactionsHeader">
        <div>
          <h1>Portfolio</h1>
          <p className="muted">
            Investment positions, broker cost basis, market values, and recent activity.
          </p>
        </div>
        <Button type="button" onClick={() => void refreshPrices()} disabled={refreshing}>
          <RefreshCw aria-hidden="true" />
          {refreshing ? 'Refreshing…' : 'Refresh quotes'}
        </Button>
      </div>

      {err && <p className="error">{err}</p>}
      {message && <p className={message.includes('not configured') ? 'uploadMsg warn' : 'uploadMsg'}>{message}</p>}

      <section className="transactionsStats" aria-busy={loading}>
        {(data?.totalsByCurrency ?? []).map((total) => (
          <article className="card transactionsStatCard" key={total.currency}>
            <p className="statLabel">{total.currency}</p>
            <p className="statValue">{formatMoney(total.marketValue, total.currency)}</p>
            <p className="muted statHint">Current portfolio value</p>
          </article>
        ))}
        {data && data.totalsByCurrency.length === 0 && (
          <article className="card transactionsStatCard">
            <p className="statLabel">Holdings</p>
            <p className="statValue">0</p>
            <p className="muted statHint">Import investment statements to populate this page</p>
          </article>
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
          <table className="table transactionsTable">
            <thead>
              <tr>
                <th>Account</th>
                <th>Symbol</th>
                <th>Name</th>
                <th>Qty</th>
                <th>Price</th>
                <th>Market value</th>
                <th>Cost basis</th>
                <th>Unrealized</th>
                <th>As of</th>
              </tr>
            </thead>
            <tbody>
              {(data?.holdings ?? []).map((holding) => (
                <tr key={holding.id}>
                  <td>{accountsById.get(holding.accountId)?.name ?? holding.accountId}</td>
                  <td>{holding.security?.symbol ?? '—'}</td>
                  <td>{holding.security?.name ?? '—'}</td>
                  <td>{holding.quantity}</td>
                  <td>
                    {holding.latestPrice
                      ? formatMoney(holding.latestPrice.price ?? 0, holding.latestPrice.currency)
                      : holding.price != null
                        ? formatMoney(holding.price, holding.currency)
                        : '—'}
                  </td>
                  <td>{formatMoney(holding.marketValue, holding.currency)}</td>
                  <td>{holding.costBasis != null ? formatMoney(holding.costBasis, holding.currency) : '—'}</td>
                  <td>{holding.unrealizedGainLoss != null ? formatMoney(holding.unrealizedGainLoss, holding.currency) : '—'}</td>
                  <td>{holding.statementDate}</td>
                </tr>
              ))}
              {data && data.holdings.length === 0 && (
                <tr>
                  <td colSpan={9} className="emptyState">
                    No holdings imported yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
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
          <table className="table transactionsTable">
            <thead>
              <tr>
                <th>Date</th>
                <th>Account</th>
                <th>Type</th>
                <th>Security</th>
                <th>Description</th>
                <th>Qty</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {(data?.recentActivities ?? []).map((activity) => (
                <tr key={activity.id}>
                  <td>{activity.tradeDate}</td>
                  <td>{accountsById.get(activity.accountId)?.name ?? activity.accountId}</td>
                  <td>{activity.activityType}</td>
                  <td>{activity.security?.symbol ?? '—'}</td>
                  <td>{activity.description}</td>
                  <td>{activity.quantity ?? '—'}</td>
                  <td>{activity.amount != null ? formatMoney(activity.amount, activity.currency) : '—'}</td>
                </tr>
              ))}
              {data && data.recentActivities.length === 0 && (
                <tr>
                  <td colSpan={7} className="emptyState">
                    No investment activity imported yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
