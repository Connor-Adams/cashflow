import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Link } from 'react-router-dom'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
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
import { TabPanel, Tabs, type TabItem } from '@/components/ui/tabs'
import { getJson, postJson } from '../lib/api'
import { formatMoney } from '../lib/formatMoney'
import type {
  PortfolioAllocation,
  PortfolioBySecurity,
  PortfolioIncome,
  PortfolioRealized,
  PortfolioSummary,
} from '../types/api'

const STALE_QUOTE_THRESHOLD_MS = 60 * 60 * 1000 // 1 hour
const CHART_COLORS = [
  'var(--chart-line-1)',
  'var(--chart-line-2)',
  'var(--chart-line-3)',
  'var(--chart-line-4)',
  'var(--chart-line-5)',
  'var(--chart-line-6)',
]

function colorFor(index: number): string {
  return CHART_COLORS[index % CHART_COLORS.length]
}

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

type TabKey = 'holdings' | 'by-security' | 'allocation' | 'income' | 'realized'

const TAB_ITEMS: TabItem[] = [
  { value: 'holdings', label: 'Holdings' },
  { value: 'by-security', label: 'By security' },
  { value: 'allocation', label: 'Allocation' },
  { value: 'income', label: 'Income' },
  { value: 'realized', label: 'Realized P&L' },
]

export function PortfolioPage() {
  const [summary, setSummary] = useState<PortfolioSummary | null>(null)
  const [allocation, setAllocation] = useState<PortfolioAllocation | null>(null)
  const [income, setIncome] = useState<PortfolioIncome | null>(null)
  const [bySec, setBySec] = useState<PortfolioBySecurity | null>(null)
  const [realized, setRealized] = useState<PortfolioRealized | null>(null)

  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<TabKey>('holdings')

  const [quotesAsOf, setQuotesAsOf] = useState<number | null>(null)
  const [now, setNow] = useState<number>(() => Date.now())

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const [summaryRes, allocRes, incomeRes, bySecRes, realizedRes] =
        await Promise.all([
          getJson<PortfolioSummary>('/api/portfolio'),
          getJson<PortfolioAllocation>('/api/portfolio/allocation'),
          getJson<PortfolioIncome>('/api/portfolio/income'),
          getJson<PortfolioBySecurity>('/api/portfolio/by-security'),
          getJson<PortfolioRealized>('/api/portfolio/realized'),
        ])
      setSummary(summaryRes)
      setAllocation(allocRes)
      setIncome(incomeRes)
      setBySec(bySecRes)
      setRealized(realizedRes)
      const fetchedAts = summaryRes.holdings
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
      setMessage(
        `Quotes: ${refreshed} refreshed, ${cached} cached${failed ? `, ${failed} failed` : ''}.`,
      )
      await load()
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Quote refresh failed')
    } finally {
      setRefreshing(false)
    }
  }

  const accountsById = new Map(
    (summary?.accounts ?? []).map((account) => [account.id, account]),
  )

  return (
    <div className="page">
      <PageHeader
        title="Portfolio"
        description="Investment positions, broker cost basis, market values, allocation, income, and realized gain/loss."
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
                  color: isStale ? 'var(--accent-warm)' : 'var(--muted-foreground)',
                }}
              >
                Last refreshed: {freshnessLabel}
              </span>
            ) : null}
          </div>
        }
      />

      {err && <p className="error">{err}</p>}
      {message && (
        <p className={message.includes('not configured') ? 'uploadMsg warn' : 'uploadMsg'}>
          {message}
        </p>
      )}

      <section className="transactionsStats" aria-busy={loading}>
        {(summary?.totalsByCurrency ?? []).map((total) => (
          <StatCard
            key={total.currency}
            label={total.currency}
            value={formatMoney(total.marketValue, total.currency)}
            hint="Current portfolio value"
          />
        ))}
        {summary && summary.totalsByCurrency.length === 0 && (
          <StatCard
            label="Holdings"
            value="0"
            hint="Import investment statements to populate this page"
          />
        )}
      </section>

      <div className="my-4">
        <Tabs
          items={TAB_ITEMS}
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as TabKey)}
        />
      </div>

      <TabPanel value="holdings" active={activeTab}>
        <HoldingsPanel summary={summary} accountsById={accountsById} />
      </TabPanel>

      <TabPanel value="by-security" active={activeTab}>
        <BySecurityPanel data={bySec} />
      </TabPanel>

      <TabPanel value="allocation" active={activeTab}>
        <AllocationPanel data={allocation} />
      </TabPanel>

      <TabPanel value="income" active={activeTab}>
        <IncomePanel data={income} />
      </TabPanel>

      <TabPanel value="realized" active={activeTab}>
        <RealizedPanel data={realized} />
      </TabPanel>
    </div>
  )
}

/* ---------------------- Holdings tab ---------------------- */

function HoldingsPanel({
  summary,
  accountsById,
}: {
  summary: PortfolioSummary | null
  accountsById: Map<number, PortfolioSummary['accounts'][number]>
}) {
  return (
    <>
      <Card className="transactionsTableCard">
        <div className="transactionsPanelHeader">
          <div>
            <h2>Holdings</h2>
            <p className="muted">
              Latest imported position per account and security. Click a symbol for the
              per-security drill.
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
              {(summary?.holdings ?? []).map((holding) => (
                <TableRow key={holding.id}>
                  <TableCell>
                    {accountsById.get(holding.accountId)?.name ?? holding.accountId}
                  </TableCell>
                  <TableCell>
                    {holding.security ? (
                      <Link
                        to={`/portfolio/security/${holding.security.id}`}
                        className="text-foreground underline-offset-2 hover:underline"
                      >
                        {holding.security.symbol}
                      </Link>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell>{holding.security?.name ?? '—'}</TableCell>
                  <TableCell>{holding.quantity}</TableCell>
                  <TableCell>
                    {holding.latestPrice
                      ? formatMoney(
                          holding.latestPrice.price ?? 0,
                          holding.latestPrice.currency,
                        )
                      : holding.price != null
                        ? formatMoney(holding.price, holding.currency)
                        : '—'}
                  </TableCell>
                  <TableCell>
                    {formatMoney(holding.marketValue, holding.currency)}
                  </TableCell>
                  <TableCell>
                    {holding.costBasis != null
                      ? formatMoney(holding.costBasis, holding.currency)
                      : '—'}
                  </TableCell>
                  <TableCell>
                    {holding.unrealizedGainLoss != null
                      ? formatMoney(holding.unrealizedGainLoss, holding.currency)
                      : '—'}
                  </TableCell>
                  <TableCell>{holding.statementDate}</TableCell>
                </TableRow>
              ))}
              {summary && summary.holdings.length === 0 && (
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
            <p className="muted">
              Trades, dividends, fees, transfers, and other imported brokerage rows.
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
                <TableHead>Security</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Qty</TableHead>
                <TableHead>Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(summary?.recentActivities ?? []).map((activity) => (
                <TableRow key={activity.id}>
                  <TableCell>{activity.tradeDate}</TableCell>
                  <TableCell>
                    {accountsById.get(activity.accountId)?.name ?? activity.accountId}
                  </TableCell>
                  <TableCell>{activity.activityType}</TableCell>
                  <TableCell>
                    {activity.security ? (
                      <Link
                        to={`/portfolio/security/${activity.security.id}`}
                        className="text-foreground underline-offset-2 hover:underline"
                      >
                        {activity.security.symbol}
                      </Link>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell>{activity.description}</TableCell>
                  <TableCell>{activity.quantity ?? '—'}</TableCell>
                  <TableCell>
                    {activity.amount != null
                      ? formatMoney(activity.amount, activity.currency)
                      : '—'}
                  </TableCell>
                </TableRow>
              ))}
              {summary && summary.recentActivities.length === 0 && (
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
    </>
  )
}

/* ---------------------- By-security tab ---------------------- */

function BySecurityPanel({ data }: { data: PortfolioBySecurity | null }) {
  const rows = data?.rows ?? []
  return (
    <Card className="transactionsTableCard">
      <div className="transactionsPanelHeader">
        <div>
          <h2>By security</h2>
          <p className="muted">
            Cross-account aggregate per ticker — combined quantity, cost basis, and
            market value across every account.
          </p>
        </div>
      </div>
      <div className="transactionsTableWrap">
        <Table className="table transactionsTable">
          <TableHeader>
            <TableRow>
              <TableHead>Symbol</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Asset type</TableHead>
              <TableHead>Total qty</TableHead>
              <TableHead>Total cost basis</TableHead>
              <TableHead>Total market value</TableHead>
              <TableHead>Unrealized</TableHead>
              <TableHead>Accounts</TableHead>
              <TableHead>Latest quote</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.securityId}>
                <TableCell>
                  <Link
                    to={`/portfolio/security/${row.securityId}`}
                    className="text-foreground underline-offset-2 hover:underline"
                  >
                    {row.symbol}
                  </Link>
                </TableCell>
                <TableCell>{row.name ?? '—'}</TableCell>
                <TableCell>{row.assetType ?? '—'}</TableCell>
                <TableCell>{row.totalQuantity}</TableCell>
                <TableCell>
                  {row.totalCostBasis != null
                    ? formatMoney(row.totalCostBasis, row.currency)
                    : '—'}
                </TableCell>
                <TableCell>{formatMoney(row.totalMarketValue, row.currency)}</TableCell>
                <TableCell>
                  {row.unrealizedGainLoss != null
                    ? formatMoney(row.unrealizedGainLoss, row.currency)
                    : '—'}
                </TableCell>
                <TableCell>{row.accountBreakdown.length}</TableCell>
                <TableCell>
                  {row.latestPrice
                    ? `${formatMoney(row.latestPrice.price, row.latestPrice.currency)} · ${row.latestPrice.pricedAt.slice(0, 10)}`
                    : '—'}
                </TableCell>
              </TableRow>
            ))}
            {rows.length === 0 && (
              <EmptyTableRow
                colSpan={9}
                title="No positions yet."
                description="Aggregated view appears after holdings are imported."
              />
            )}
          </TableBody>
        </Table>
      </div>
    </Card>
  )
}

/* ---------------------- Allocation tab ---------------------- */

function AllocationPanel({ data }: { data: PortfolioAllocation | null }) {
  const empty =
    !data ||
    (data.byAssetType.length === 0 &&
      data.bySecurity.length === 0 &&
      data.byAccount.length === 0)

  if (empty) {
    return (
      <Card>
        <p className="muted">
          Allocation is computed from the latest holdings snapshot per account/security.
          Import holdings to see this view.
        </p>
      </Card>
    )
  }

  return (
    <>
      <div className="grid gap-4 lg:grid-cols-3">
        <AllocationDonut
          title="By asset type"
          slices={data!.byAssetType.map((r) => ({
            key: `${r.assetType}|${r.currency}`,
            name: `${r.assetType} (${r.currency})`,
            value: r.marketValue,
            currency: r.currency,
            percentage: r.percentage,
          }))}
        />
        <AllocationDonut
          title="By security"
          slices={data!.bySecurity.slice(0, 10).map((r) => ({
            key: `${r.securityId}|${r.currency}`,
            name: `${r.symbol} (${r.currency})`,
            value: r.marketValue,
            currency: r.currency,
            percentage: r.percentage,
          }))}
        />
        <AllocationDonut
          title="By account"
          slices={data!.byAccount.map((r) => ({
            key: `${r.accountId}|${r.currency}`,
            name: `${r.accountName} (${r.currency})`,
            value: r.marketValue,
            currency: r.currency,
            percentage: r.percentage,
          }))}
        />
      </div>

      <Card className="transactionsTableCard mt-4">
        <div className="transactionsPanelHeader">
          <div>
            <h2>Breakdown</h2>
            <p className="muted">All allocation buckets in numeric form. Percentages are computed per currency.</p>
          </div>
        </div>
        <div className="transactionsTableWrap">
          <Table className="table transactionsTable">
            <TableHeader>
              <TableRow>
                <TableHead>Group</TableHead>
                <TableHead>Bucket</TableHead>
                <TableHead>Market value</TableHead>
                <TableHead>%</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data!.byAssetType.map((row) => (
                <TableRow key={`assetType|${row.assetType}|${row.currency}`}>
                  <TableCell>Asset type</TableCell>
                  <TableCell>
                    {row.assetType} ({row.currency})
                  </TableCell>
                  <TableCell>{formatMoney(row.marketValue, row.currency)}</TableCell>
                  <TableCell>{row.percentage.toFixed(1)}%</TableCell>
                </TableRow>
              ))}
              {data!.byAccount.map((row) => (
                <TableRow key={`account|${row.accountId}|${row.currency}`}>
                  <TableCell>Account</TableCell>
                  <TableCell>
                    {row.accountName} ({row.currency})
                  </TableCell>
                  <TableCell>{formatMoney(row.marketValue, row.currency)}</TableCell>
                  <TableCell>{row.percentage.toFixed(1)}%</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Card>
    </>
  )
}

type DonutSlice = {
  key: string
  name: string
  value: number
  currency: string
  percentage: number
}

function AllocationDonut({ title, slices }: { title: string; slices: DonutSlice[] }) {
  if (slices.length === 0) {
    return (
      <Card>
        <div className="transactionsPanelHeader">
          <h2>{title}</h2>
        </div>
        <p className="muted">No data.</p>
      </Card>
    )
  }
  return (
    <Card>
      <div className="transactionsPanelHeader">
        <h2 className="text-base">{title}</h2>
      </div>
      <div style={{ width: '100%', height: 240 }}>
        <ResponsiveContainer>
          <PieChart>
            <Pie
              data={slices}
              dataKey="value"
              nameKey="name"
              innerRadius={48}
              outerRadius={84}
              paddingAngle={2}
            >
              {slices.map((s, i) => (
                <Cell key={s.key} fill={colorFor(i)} />
              ))}
            </Pie>
            <Tooltip
              formatter={(value, _name, ctx) => {
                const v = typeof value === 'number' ? value : Number(value)
                if (!Number.isFinite(v)) return ''
                const slice = (ctx?.payload ?? {}) as DonutSlice
                return [
                  `${formatMoney(v, slice.currency || 'CAD')} (${slice.percentage?.toFixed(1) ?? '0.0'}%)`,
                  slice.name ?? '',
                ]
              }}
            />
            <Legend verticalAlign="bottom" height={36} />
          </PieChart>
        </ResponsiveContainer>
      </div>
    </Card>
  )
}

/* ---------------------- Income tab ---------------------- */

function IncomePanel({ data }: { data: PortfolioIncome | null }) {
  if (!data || (data.byMonth.length === 0 && data.totals.length === 0)) {
    return (
      <Card>
        <p className="muted">
          No dividend or interest activity yet. Import investment statements to populate
          this view.
        </p>
      </Card>
    )
  }

  return (
    <>
      <section className="transactionsStats">
        {data.totals.map((row) => (
          <StatCard
            key={row.currency}
            label={`${row.currency} total income`}
            value={formatMoney(row.total, row.currency)}
            hint={`Dividends ${formatMoney(row.dividend, row.currency)} · Interest ${formatMoney(row.interest, row.currency)}`}
          />
        ))}
      </section>

      <IncomeMonthlyChart data={data} />

      <Card className="transactionsTableCard mt-4">
        <div className="transactionsPanelHeader">
          <div>
            <h2>By security</h2>
            <p className="muted">
              Top securities by total income (dividends + interest).
            </p>
          </div>
        </div>
        <div className="transactionsTableWrap">
          <Table className="table transactionsTable">
            <TableHeader>
              <TableRow>
                <TableHead>Symbol</TableHead>
                <TableHead>Currency</TableHead>
                <TableHead>Dividend</TableHead>
                <TableHead>Interest</TableHead>
                <TableHead>Total</TableHead>
                <TableHead>Events</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.bySecurity.slice(0, 20).map((row) => (
                <TableRow key={`${row.securityId ?? 'null'}|${row.currency}`}>
                  <TableCell>
                    {row.securityId != null && row.symbol ? (
                      <Link
                        to={`/portfolio/security/${row.securityId}`}
                        className="text-foreground underline-offset-2 hover:underline"
                      >
                        {row.symbol}
                      </Link>
                    ) : (
                      row.symbol ?? '—'
                    )}
                  </TableCell>
                  <TableCell>{row.currency}</TableCell>
                  <TableCell>{formatMoney(row.dividend, row.currency)}</TableCell>
                  <TableCell>{formatMoney(row.interest, row.currency)}</TableCell>
                  <TableCell>{formatMoney(row.total, row.currency)}</TableCell>
                  <TableCell>{row.activityCount}</TableCell>
                </TableRow>
              ))}
              {data.bySecurity.length === 0 && (
                <EmptyTableRow
                  colSpan={6}
                  title="No income by security."
                  description="Dividends and interest appear here once imported."
                />
              )}
            </TableBody>
          </Table>
        </div>
      </Card>
    </>
  )
}

function IncomeMonthlyChart({ data }: { data: PortfolioIncome }) {
  const currencies = useMemo(() => {
    const set = new Set<string>()
    for (const row of data.byMonth) set.add(row.currency)
    return [...set].sort()
  }, [data])
  const [currency, setCurrency] = useState<string>(currencies[0] ?? '')
  useEffect(() => {
    if (currencies.length > 0 && !currencies.includes(currency)) {
      setCurrency(currencies[0])
    }
  }, [currencies, currency])

  const rows = useMemo(
    () => data.byMonth.filter((r) => r.currency === currency),
    [data, currency],
  )

  return (
    <Card>
      <div className="transactionsPanelHeader">
        <div>
          <h2 className="text-base">Income by month</h2>
          <p className="muted">Stacked dividend + interest by month.</p>
        </div>
        {currencies.length > 1 && (
          <select
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            className="border border-border bg-card rounded-md px-2 py-1 text-sm"
          >
            {currencies.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        )}
      </div>
      <div style={{ width: '100%', height: 280 }}>
        <ResponsiveContainer>
          <BarChart data={rows}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="month" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => `${v}`} />
            <Tooltip
              formatter={(value, name) => {
                const v = typeof value === 'number' ? value : Number(value)
                if (!Number.isFinite(v)) return ''
                return [formatMoney(v, currency), String(name)]
              }}
            />
            <Legend />
            <Bar
              dataKey="dividend"
              stackId="income"
              fill={colorFor(0)}
              name="Dividend"
            />
            <Bar
              dataKey="interest"
              stackId="income"
              fill={colorFor(1)}
              name="Interest"
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Card>
  )
}

/* ---------------------- Realized tab ---------------------- */

function RealizedPanel({ data }: { data: PortfolioRealized | null }) {
  if (!data || data.events.length === 0) {
    return (
      <Card>
        <p className="muted">
          No realized SELL events yet. Realized gain/loss appears here after a sell
          activity is imported.
        </p>
      </Card>
    )
  }

  // Running cumulative realized gain per currency for the events table.
  const runningByCurrency = new Map<string, number>()
  const eventsWithRunning = data.events.map((ev) => {
    const prev = runningByCurrency.get(ev.currency) ?? 0
    const next = prev + ev.realizedGain
    runningByCurrency.set(ev.currency, next)
    return { ...ev, runningTotal: next }
  })

  return (
    <>
      <section className="transactionsStats">
        {data.totals.map((row) => (
          <StatCard
            key={row.currency}
            label={`${row.currency} realized to date`}
            value={formatMoney(row.realizedGain, row.currency)}
            hint={`${row.eventCount} sell event${row.eventCount === 1 ? '' : 's'}`}
          />
        ))}
      </section>

      <Card className="transactionsTableCard mt-4">
        <div className="transactionsPanelHeader">
          <div>
            <h2>By security</h2>
            <p className="muted">Realized gain/loss aggregated per ticker.</p>
          </div>
        </div>
        <div className="transactionsTableWrap">
          <Table className="table transactionsTable">
            <TableHeader>
              <TableRow>
                <TableHead>Symbol</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Currency</TableHead>
                <TableHead>Realized gain</TableHead>
                <TableHead>Sells</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.bySecurity.map((row) => (
                <TableRow key={`${row.securityId}|${row.currency}`}>
                  <TableCell>
                    <Link
                      to={`/portfolio/security/${row.securityId}`}
                      className="text-foreground underline-offset-2 hover:underline"
                    >
                      {row.symbol}
                    </Link>
                  </TableCell>
                  <TableCell>{row.name ?? '—'}</TableCell>
                  <TableCell>{row.currency}</TableCell>
                  <TableCell>{formatMoney(row.realizedGain, row.currency)}</TableCell>
                  <TableCell>{row.eventCount}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Card>

      <Card className="transactionsTableCard mt-4">
        <div className="transactionsPanelHeader">
          <div>
            <h2>Events</h2>
            <p className="muted">
              Every SELL with the prevailing ACB-per-unit at the time of sale and the
              running cumulative realized total.
            </p>
          </div>
        </div>
        <div className="transactionsTableWrap">
          <Table className="table transactionsTable">
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Symbol</TableHead>
                <TableHead>Qty sold</TableHead>
                <TableHead>Proceeds</TableHead>
                <TableHead>ACB / unit</TableHead>
                <TableHead>Realized</TableHead>
                <TableHead>Running</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {eventsWithRunning.map((ev) => (
                <TableRow key={ev.activityId}>
                  <TableCell>{ev.tradeDate}</TableCell>
                  <TableCell>{ev.accountName}</TableCell>
                  <TableCell>
                    <Link
                      to={`/portfolio/security/${ev.securityId}`}
                      className="text-foreground underline-offset-2 hover:underline"
                    >
                      {ev.symbol}
                    </Link>
                  </TableCell>
                  <TableCell>{ev.qtySold}</TableCell>
                  <TableCell>{formatMoney(ev.proceeds, ev.currency)}</TableCell>
                  <TableCell>{formatMoney(ev.acbAtSale, ev.currency)}</TableCell>
                  <TableCell>{formatMoney(ev.realizedGain, ev.currency)}</TableCell>
                  <TableCell>{formatMoney(ev.runningTotal, ev.currency)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Card>
    </>
  )
}
