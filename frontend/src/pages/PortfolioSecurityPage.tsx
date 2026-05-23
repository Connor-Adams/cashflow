/**
 * Per-security drill view. Lives at /portfolio/security/:id. Sources
 * GET /api/portfolio/security/:id which already returns the full
 * payload — per-account ACB results, full activities timeline, every
 * historical holding snapshot, and the latest quote.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Badge } from '@/components/ui/badge'
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
import { getJson } from '../lib/api'
import { formatMoney } from '../lib/formatMoney'
import type { PortfolioSecurityDetail } from '../types/api'

export function PortfolioSecurityPage() {
  const { id } = useParams<{ id: string }>()
  const [data, setData] = useState<PortfolioSecurityDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!id) return
    setLoading(true)
    setErr(null)
    try {
      const res = await getJson<PortfolioSecurityDetail>(`/api/portfolio/security/${id}`)
      setData(res)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load security detail')
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  const accountById = useMemo(() => {
    const map = new Map<number, string>()
    for (const p of data?.perAccount ?? []) map.set(p.accountId, p.accountName)
    return map
  }, [data])

  // Running position across activities, computed in display order.
  const activitiesWithRunning = useMemo(() => {
    if (!data) return []
    // Group by account; running position is per-account.
    const runByAccount = new Map<number, number>()
    return data.activities
      .slice()
      .sort((a, b) =>
        a.tradeDate === b.tradeDate ? a.id - b.id : a.tradeDate.localeCompare(b.tradeDate),
      )
      .map((a) => {
        let pos = runByAccount.get(a.accountId) ?? 0
        if (a.activityType === 'buy' && a.quantity != null) pos += a.quantity
        else if (a.activityType === 'sell' && a.quantity != null) pos -= a.quantity
        runByAccount.set(a.accountId, pos)
        return { ...a, runningPosition: pos }
      })
  }, [data])

  if (!id) {
    return (
      <div className="page">
        <p className="error">Missing security id.</p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="page">
        <PageHeader title="Loading security…" />
      </div>
    )
  }

  if (err) {
    return (
      <div className="page">
        <PageHeader title="Security" />
        <p className="error">{err}</p>
        <Link to="/portfolio">
          <Button variant="outline">Back to portfolio</Button>
        </Link>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="page">
        <PageHeader title="Security not found" />
        <Link to="/portfolio">
          <Button variant="outline">Back to portfolio</Button>
        </Link>
      </div>
    )
  }

  const { security, perAccount, combined, holdings, latestPrice } = data
  const unrealized =
    combined.currentCostBasis !== 0
      ? combined.currentMarketValue - combined.currentCostBasis
      : null

  return (
    <div className="page">
      <PageHeader
        title={security.name ? `${security.symbol} — ${security.name}` : security.symbol}
        description={
          <span className="flex items-center gap-2 flex-wrap">
            {security.assetType ? (
              <Badge variant="secondary">{security.assetType}</Badge>
            ) : null}
            <Badge variant="outline">{security.currency}</Badge>
            <span>
              Combined across accounts plus per-account ACB and the full activity timeline.
            </span>
          </span>
        }
        actions={
          <Link to="/portfolio">
            <Button variant="outline">Back to portfolio</Button>
          </Link>
        }
      />

      <section className="transactionsStats">
        <StatCard
          label="Current quantity"
          value={String(combined.currentQuantity)}
          hint="Across all visible accounts"
        />
        <StatCard
          label="Market value"
          value={formatMoney(combined.currentMarketValue, combined.currency)}
          hint={
            latestPrice
              ? `Quote ${formatMoney(latestPrice.price, latestPrice.currency)} · ${latestPrice.pricedAt.slice(0, 10)}`
              : 'No live quote'
          }
        />
        <StatCard
          label="Cost basis"
          value={formatMoney(combined.currentCostBasis, combined.currency)}
          hint="Broker-reported"
        />
        <StatCard
          label="Unrealized"
          value={unrealized != null ? formatMoney(unrealized, combined.currency) : '—'}
          hint="MV − cost basis"
        />
        <StatCard
          label="Realized to date"
          value={formatMoney(combined.realizedTotal, combined.currency)}
          hint="Weighted-average ACB, all SELLs"
        />
        <StatCard
          label="Lifetime income"
          value={formatMoney(
            combined.income.dividend + combined.income.interest,
            combined.currency,
          )}
          hint={`Dividends ${formatMoney(combined.income.dividend, combined.currency)} · Interest ${formatMoney(combined.income.interest, combined.currency)}`}
        />
      </section>

      <h2 className="mt-6">Per-account</h2>
      <div className="grid gap-4 lg:grid-cols-2">
        {perAccount.map((row) => (
          <PerAccountCard key={row.accountId} row={row} />
        ))}
        {perAccount.length === 0 && (
          <Card>
            <p className="muted">No accounts hold this security.</p>
          </Card>
        )}
      </div>

      <Card className="transactionsTableCard mt-4">
        <div className="transactionsPanelHeader">
          <div>
            <h2>Activity timeline</h2>
            <p className="muted">
              Chronological buys, sells, dividends, interest, and other rows. Running
              position is per-account.
            </p>
          </div>
        </div>
        <div className="transactionsTableWrap">
          <Table className="table transactionsTable">
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Qty</TableHead>
                <TableHead>Price</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Running</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {activitiesWithRunning.map((a) => (
                <TableRow key={a.id}>
                  <TableCell>{a.tradeDate}</TableCell>
                  <TableCell>{accountById.get(a.accountId) ?? a.accountName}</TableCell>
                  <TableCell>{a.activityType}</TableCell>
                  <TableCell>{a.quantity ?? '—'}</TableCell>
                  <TableCell>
                    {a.price != null ? formatMoney(a.price, a.currency) : '—'}
                  </TableCell>
                  <TableCell>
                    {a.amount != null ? formatMoney(a.amount, a.currency) : '—'}
                  </TableCell>
                  <TableCell>{a.runningPosition}</TableCell>
                </TableRow>
              ))}
              {activitiesWithRunning.length === 0 && (
                <EmptyTableRow
                  colSpan={7}
                  title="No activities."
                  description="No imported trades or income for this security yet."
                />
              )}
            </TableBody>
          </Table>
        </div>
      </Card>

      <Card className="transactionsTableCard mt-4">
        <div className="transactionsPanelHeader">
          <div>
            <h2>Historical holdings snapshots</h2>
            <p className="muted">
              Every imported snapshot row for this security, newest first.
            </p>
          </div>
        </div>
        <div className="transactionsTableWrap">
          <Table className="table transactionsTable">
            <TableHeader>
              <TableRow>
                <TableHead>Statement date</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Qty</TableHead>
                <TableHead>Price</TableHead>
                <TableHead>Market value</TableHead>
                <TableHead>Cost basis</TableHead>
                <TableHead>Unrealized</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {holdings.map((h) => (
                <TableRow key={h.id}>
                  <TableCell>{h.statementDate}</TableCell>
                  <TableCell>{h.accountName}</TableCell>
                  <TableCell>{h.quantity}</TableCell>
                  <TableCell>
                    {h.price != null ? formatMoney(h.price, h.currency) : '—'}
                  </TableCell>
                  <TableCell>
                    {h.marketValue != null ? formatMoney(h.marketValue, h.currency) : '—'}
                  </TableCell>
                  <TableCell>
                    {h.costBasis != null ? formatMoney(h.costBasis, h.currency) : '—'}
                  </TableCell>
                  <TableCell>
                    {h.unrealizedGainLoss != null
                      ? formatMoney(h.unrealizedGainLoss, h.currency)
                      : '—'}
                  </TableCell>
                </TableRow>
              ))}
              {holdings.length === 0 && (
                <EmptyTableRow
                  colSpan={7}
                  title="No snapshots."
                  description="No historical holdings imported for this security."
                />
              )}
            </TableBody>
          </Table>
        </div>
      </Card>
    </div>
  )
}

function PerAccountCard({ row }: { row: PortfolioSecurityDetail['perAccount'][number] }) {
  const acbCurrency = row.acb.currency || 'CAD'
  const timeline = row.acb.timeline.map((t) => ({
    asOf: t.asOf,
    acbPerUnit: Number(t.acbPerUnit.toFixed(4)),
    quantity: t.quantity,
  }))
  return (
    <Card>
      <div className="transactionsPanelHeader">
        <div>
          <h2 className="text-base">{row.accountName}</h2>
          <p className="muted">
            Qty {row.currentQuantity} · MV{' '}
            {formatMoney(row.currentMarketValue, acbCurrency)} · Cost{' '}
            {formatMoney(row.currentCostBasis, acbCurrency)} · Realized{' '}
            {formatMoney(row.acb.realizedTotal, acbCurrency)}
          </p>
        </div>
      </div>
      {timeline.length > 0 ? (
        <div style={{ width: '100%', height: 200 }}>
          <ResponsiveContainer>
            <LineChart data={timeline}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="asOf" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip
                formatter={(value, name) => {
                  const v = typeof value === 'number' ? value : Number(value)
                  if (!Number.isFinite(v)) return ''
                  const nameStr = String(name)
                  return [
                    nameStr === 'acbPerUnit' ? formatMoney(v, acbCurrency) : String(v),
                    nameStr === 'acbPerUnit' ? 'ACB / unit' : 'Quantity',
                  ]
                }}
              />
              <Line
                type="monotone"
                dataKey="acbPerUnit"
                stroke="var(--chart-line-1)"
                strokeWidth={2}
                dot
                name="ACB / unit"
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="muted">No buy/sell activity yet for this account.</p>
      )}
      {row.acb.warnings.length > 0 && (
        <ul className="muted text-xs mt-2 list-disc list-inside">
          {row.acb.warnings.slice(0, 3).map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
    </Card>
  )
}
