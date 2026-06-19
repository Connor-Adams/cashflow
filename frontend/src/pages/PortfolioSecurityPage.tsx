/**
 * Per-security drill view (slice F). Composes the new cards on top of
 * /api/portfolio/security/:id, /api/portfolio/security/:id/overview,
 * /api/portfolio/security/:id/dividends, /api/portfolio/security/:id/prices.
 * Retains the existing per-account ACB cards, activity timeline, and
 * holdings snapshots below.
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
import { Button } from '@cashflow/ui'
import { Card } from '@cashflow/ui'
import { EmptyTableRow } from '@cashflow/ui'
import { MetricStat } from '@/components/ui/metric-stat'
import { PageHeader } from '@/components/ui/page-header'
import { SectionHeader } from '@/components/ui/section-header'
import { StatCard } from '@/components/ui/stat-card'
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@cashflow/ui'
import { TableCard, type TableColumn } from '@/components/ui/table-card'
import { getJson } from '../lib/api'
import { formatMoney } from '../lib/formatMoney'
import { AboutCard } from './portfolio-security/AboutCard'
import { AnalystRecCard } from './portfolio-security/AnalystRecCard'
import { DividendHistoryCard } from './portfolio-security/DividendHistoryCard'
import { EarningsCard } from './portfolio-security/EarningsCard'
import { FundFactsCard } from './portfolio-security/FundFactsCard'
import { MarketDataCard } from './portfolio-security/MarketDataCard'
import { NewsCard } from './portfolio-security/NewsCard'
import { PriceChartCard } from './portfolio-security/PriceChartCard'
import { SecurityHeader } from './portfolio-security/SecurityHeader'
import type {
  PortfolioSecurityDetail,
  PortfolioSecurityOverview,
} from '../types/api'

type HoldingRow = PortfolioSecurityDetail['holdings'][number]

const holdingsColumns: TableColumn<HoldingRow>[] = [
  { key: 'statementDate', header: 'Statement date', sortable: true },
  { key: 'accountName', header: 'Account', sortable: true },
  { key: 'quantity', header: 'Qty', sortable: true, align: 'right' },
  {
    key: 'price',
    header: 'Price',
    sortable: true,
    align: 'right',
    accessor: (h) => h.price ?? null,
    render: (h) => (h.price != null ? formatMoney(h.price, h.currency) : '—'),
  },
  {
    key: 'marketValue',
    header: 'Market value',
    sortable: true,
    align: 'right',
    accessor: (h) => h.marketValue ?? null,
    render: (h) => (h.marketValue != null ? formatMoney(h.marketValue, h.currency) : '—'),
  },
  {
    key: 'costBasis',
    header: 'Cost basis',
    sortable: true,
    align: 'right',
    accessor: (h) => h.costBasis ?? null,
    render: (h) => (h.costBasis != null ? formatMoney(h.costBasis, h.currency) : '—'),
  },
  {
    key: 'unrealizedGainLoss',
    header: 'Unrealized',
    sortable: true,
    align: 'right',
    accessor: (h) => h.unrealizedGainLoss ?? null,
    render: (h) => (h.unrealizedGainLoss != null ? formatMoney(h.unrealizedGainLoss, h.currency) : '—'),
  },
]

export function PortfolioSecurityPage() {
  const { id } = useParams<{ id: string }>()
  const [data, setData] = useState<PortfolioSecurityDetail | null>(null)
  const [overview, setOverview] = useState<PortfolioSecurityOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!id) return
    setLoading(true)
    setErr(null)
    try {
      const [base, over] = await Promise.all([
        getJson<PortfolioSecurityDetail>(`/api/portfolio/security/${id}`),
        getJson<PortfolioSecurityOverview>(`/api/portfolio/security/${id}/overview`).catch(() => null),
      ])
      setData(base)
      setOverview(over)
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

  const activitiesWithRunning = useMemo(() => {
    if (!data) return []
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

  if (!id) return <div className="page"><p className="error">Missing security id.</p></div>
  if (loading) return <div className="page"><PageHeader title="Loading security…" /></div>
  if (err) return (
    <div className="page">
      <PageHeader title="Security" />
      <p className="error">{err}</p>
      <Link to="/portfolio"><Button variant="outline">Back to portfolio</Button></Link>
    </div>
  )
  if (!data) return (
    <div className="page">
      <PageHeader title="Security not found" />
      <Link to="/portfolio"><Button variant="outline">Back to portfolio</Button></Link>
    </div>
  )

  const { security, perAccount, combined, holdings } = data
  const unrealized =
    combined.currentCostBasis !== 0
      ? combined.currentMarketValue - combined.currentCostBasis
      : null

  return (
    <div className="page">
      <PageHeader
        title=""
        actions={<Link to="/portfolio"><Button variant="outline">Back to portfolio</Button></Link>}
      />
      <SecurityHeader security={security} overview={overview} />

      <section className="transactionsStats mt-4">
        <StatCard label="Quantity" value={String(combined.currentQuantity)} hint="Across all accounts" />
        <StatCard label="Market value" value={formatMoney(combined.currentMarketValue, combined.currency)} />
        <StatCard label="Cost basis" value={formatMoney(combined.currentCostBasis, combined.currency)} />
        <StatCard
          label="Unrealized"
          value={unrealized != null ? formatMoney(unrealized, combined.currency) : '—'}
          hint="MV − cost basis"
        />
        <MetricStat
          label="Today"
          value={combined.todayChangePct != null ? `${combined.todayChangePct >= 0 ? '+' : ''}${combined.todayChangePct.toFixed(2)}%` : '—'}
          deltaPct={combined.todayChangePct ?? undefined}
          hint="vs prior close"
        />
        <MetricStat
          label="30d return"
          value={combined.thirtyDayReturnPct != null ? `${combined.thirtyDayReturnPct >= 0 ? '+' : ''}${combined.thirtyDayReturnPct.toFixed(2)}%` : '—'}
          deltaPct={combined.thirtyDayReturnPct ?? undefined}
          hint="price + dividends"
        />
        <MetricStat
          label="Yield on cost (TTM)"
          value={combined.yieldOnCostPct != null ? `${combined.yieldOnCostPct.toFixed(2)}%` : '—'}
          hint="TTM dividends / cost basis"
        />
        <StatCard
          label="Realized to date"
          value={formatMoney(combined.realizedTotal, combined.currency)}
          hint="Weighted-average ACB"
        />
      </section>

      <div className="mt-4">
        <MarketDataCard overview={overview} currency={combined.currency} />
      </div>

      <div className="mt-4">
        <EarningsCard overview={overview} />
      </div>

      <div className="mt-4">
        <AnalystRecCard overview={overview} />
      </div>

      <div className="mt-4">
        <FundFactsCard overview={overview} currency={combined.currency} />
      </div>

      <div className="mt-4">
        <PriceChartCard securityId={security.id} currency={combined.currency} />
      </div>

      <div className="mt-4">
        <DividendHistoryCard securityId={security.id} currency={combined.currency} />
      </div>

      <div className="mt-4">
        <NewsCard securityId={security.id} />
      </div>

      <div className="mt-4">
        <AboutCard overview={overview} />
      </div>

      <h2 className="mt-6">Per-account</h2>
      <div className="grid gap-4 lg:grid-cols-2">
        {perAccount.map((row) => (
          <PerAccountCard key={row.accountId} row={row} />
        ))}
        {perAccount.length === 0 && (
          <Card><p className="muted">No accounts hold this security.</p></Card>
        )}
      </div>

      <TableCard
        className="mt-4"
        title="Activity timeline"
        description="Chronological buys, sells, dividends, interest, and other rows. Running position is per-account."
      >
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
              <TableCell>{a.price != null ? formatMoney(a.price, a.currency) : '—'}</TableCell>
              <TableCell>{a.amount != null ? formatMoney(a.amount, a.currency) : '—'}</TableCell>
              <TableCell>{a.runningPosition}</TableCell>
            </TableRow>
          ))}
          {activitiesWithRunning.length === 0 && (
            <EmptyTableRow colSpan={7} title="No activities." description="No imported trades or income for this security yet." />
          )}
        </TableBody>
      </TableCard>

      <TableCard<HoldingRow>
        className="mt-4"
        title="Historical holdings snapshots"
        description="Every imported snapshot row for this security, newest first."
        columns={holdingsColumns}
        rows={holdings}
        getRowKey={(h) => h.id}
        empty="No snapshots."
      />
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
      <SectionHeader
        title={row.accountName}
        description={
          <>
            Qty {row.currentQuantity} · MV {formatMoney(row.currentMarketValue, acbCurrency)} · Cost{' '}
            {formatMoney(row.currentCostBasis, acbCurrency)} · Realized{' '}
            {formatMoney(row.acb.realizedTotal, acbCurrency)}
          </>
        }
      />
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
              <Line type="monotone" dataKey="acbPerUnit" stroke="var(--chart-line-1)" strokeWidth={2} dot name="ACB / unit" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="muted">No buy/sell activity yet for this account.</p>
      )}
      {row.acb.warnings.length > 0 && (
        <ul className="muted text-xs mt-2 list-disc list-inside">
          {row.acb.warnings.slice(0, 3).map((w, i) => (<li key={i}>{w}</li>))}
        </ul>
      )}
    </Card>
  )
}
