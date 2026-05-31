import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { safePct } from '@/lib/num'
import { RefreshCw } from 'lucide-react'
import { Link } from 'react-router-dom'
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
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { EmptyTableRow } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/ui/page-header'
import { SecurityLogo } from '@/components/ui/security-logo'
import { Sparkline } from '@/components/ui/sparkline'
import { MetricStat } from '@/components/ui/metric-stat'
import { PctDeltaCell } from '@/components/ui/pct-delta-cell'
import { StatCard } from '@/components/ui/stat-card'
import { SortableTableHead } from '@/components/ui/sortable-table-head'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { TabPanel, Tabs, type TabItem } from '@/components/ui/tabs'
import { AllocationDonut } from '@/components/ui/allocation-donut'
import { AccountTypePanel } from './portfolio-account-type/AccountTypePanel'
import { ForwardIncomePanel } from './portfolio-forward-income/ForwardIncomePanel'
import { PerformancePanel } from './portfolio-performance/PerformancePanel'
import { getJson, postJson } from '../lib/api'
import { formatMoney } from '../lib/formatMoney'
import type {
  PortfolioAllocation,
  PortfolioBySecurity,
  PortfolioIncome,
  PortfolioRealized,
  PortfolioSparklinePoint,
  PortfolioSparklines,
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

type TabKey = 'holdings' | 'performance' | 'by-security' | 'allocation' | 'by-account-type' | 'income' | 'forward-income' | 'realized'

const TAB_ITEMS: TabItem[] = [
  { value: 'holdings', label: 'Holdings' },
  { value: 'performance', label: 'Performance' },
  { value: 'by-security', label: 'By security' },
  { value: 'allocation', label: 'Allocation' },
  { value: 'by-account-type', label: 'By account type' },
  { value: 'income', label: 'Income' },
  { value: 'forward-income', label: 'Forward income' },
  { value: 'realized', label: 'Realized P&L' },
]

export function PortfolioPage() {
  const [summary, setSummary] = useState<PortfolioSummary | null>(null)
  const [allocation, setAllocation] = useState<PortfolioAllocation | null>(null)
  const [bySec, setBySec] = useState<PortfolioBySecurity | null>(null)

  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<TabKey>('holdings')

  const [sparklines, setSparklines] = useState<Map<number, PortfolioSparklinePoint[]>>(new Map())

  const [quotesAsOf, setQuotesAsOf] = useState<number | null>(null)
  const [now, setNow] = useState<number>(() => Date.now())

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const [summaryRes, allocRes, bySecRes, sparkRes] =
        await Promise.all([
          getJson<PortfolioSummary>('/api/portfolio'),
          getJson<PortfolioAllocation>('/api/portfolio/allocation'),
          getJson<PortfolioBySecurity>('/api/portfolio/by-security'),
          getJson<PortfolioSparklines>('/api/portfolio/sparklines?range=30d'),
        ])
      setSummary(summaryRes)
      setAllocation(allocRes)
      setBySec(bySecRes)
      setSparklines(
        new Map(
          Object.entries(sparkRes.bySecurityId).map(([k, v]) => [Number(k), v]),
        ),
      )
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
        {summary?.unifiedTotal != null && (
          <MetricStat
            key="unified-cad"
            label="Total (CAD)"
            value={formatMoney(summary.unifiedTotal.marketValue, 'CAD')}
            deltaPct={summary.unifiedTotal.todayChangePct ?? undefined}
            hint={`Converted from ${summary.unifiedTotal.ratesUsed.length} ${summary.unifiedTotal.ratesUsed.length === 1 ? 'currency' : 'currencies'} via BoC daily rates`}
          />
        )}
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

      <TabPanel value="performance" active={activeTab}>
        <PerformancePanel />
      </TabPanel>

      <TabPanel value="holdings" active={activeTab}>
        <HoldingsPanel summary={summary} accountsById={accountsById} sparklines={sparklines} />
      </TabPanel>

      <TabPanel value="by-security" active={activeTab}>
        <BySecurityPanel data={bySec} sparklines={sparklines} />
      </TabPanel>

      <TabPanel value="allocation" active={activeTab}>
        <AllocationPanel data={allocation} />
      </TabPanel>

      <TabPanel value="by-account-type" active={activeTab}>
        <AccountTypePanel />
      </TabPanel>

      <TabPanel value="income" active={activeTab}>
        <IncomePanel />
      </TabPanel>

      <TabPanel value="forward-income" active={activeTab}>
        <ForwardIncomePanel />
      </TabPanel>

      <TabPanel value="realized" active={activeTab}>
        <RealizedPanel />
      </TabPanel>
    </div>
  )
}

/* ---------------------- Holdings tab ---------------------- */

function HoldingsPanel({
  summary,
  accountsById,
  sparklines,
}: {
  summary: PortfolioSummary | null
  accountsById: Map<number, PortfolioSummary['accounts'][number]>
  sparklines: Map<number, PortfolioSparklinePoint[]>
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
                <TableHead>Today</TableHead>
                <TableHead>30d Δ</TableHead>
                <TableHead>Weight</TableHead>
                <TableHead>Yield</TableHead>
                <TableHead>30d</TableHead>
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
                      <span className="flex items-center gap-2">
                        <SecurityLogo
                          size="sm"
                          symbol={holding.security.symbol}
                          name={holding.security.name}
                          assetType={holding.security.assetType}
                          currency={holding.security.currency}
                        />
                        <Link
                          to={`/portfolio/security/${holding.security.id}`}
                          className="text-foreground underline-offset-2 hover:underline"
                        >
                          {holding.security.symbol}
                        </Link>
                      </span>
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
                  <TableCell>
                    <PctDeltaCell value={holding.todayChangePct} />
                  </TableCell>
                  <TableCell>
                    <PctDeltaCell value={holding.thirtyDayReturnPct} />
                  </TableCell>
                  <TableCell>
                    {holding.weightPct != null ? `${holding.weightPct.toFixed(1)}%` : '—'}
                  </TableCell>
                  <TableCell>
                    {holding.yieldOnCostPct != null ? `${holding.yieldOnCostPct.toFixed(2)}%` : '—'}
                  </TableCell>
                  <TableCell>
                    {holding.security ? (
                      <Sparkline
                        data={(sparklines.get(holding.security.id) ?? []).map((p) => ({
                          date: p.date,
                          value: p.close,
                        }))}
                      />
                    ) : null}
                  </TableCell>
                  <TableCell>{holding.statementDate}</TableCell>
                </TableRow>
              ))}
              {summary && summary.holdings.length === 0 && (
                <EmptyTableRow
                  colSpan={14}
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

function BySecurityPanel({
  data,
  sparklines,
}: {
  data: PortfolioBySecurity | null
  sparklines: Map<number, PortfolioSparklinePoint[]>
}) {
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
              <TableHead>Today</TableHead>
              <TableHead>30d Δ</TableHead>
              <TableHead>Weight</TableHead>
              <TableHead>Total Return</TableHead>
              <TableHead>Accounts</TableHead>
              <TableHead>30d</TableHead>
              <TableHead>Latest quote</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.securityId}>
                <TableCell>
                  <span className="flex items-center gap-2">
                    <SecurityLogo
                      size="sm"
                      symbol={row.symbol}
                      name={row.name}
                      assetType={row.assetType}
                      currency={row.currency}
                    />
                    <Link
                      to={`/portfolio/security/${row.securityId}`}
                      className="text-foreground underline-offset-2 hover:underline"
                    >
                      {row.symbol}
                    </Link>
                  </span>
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
                <TableCell>
                  <PctDeltaCell value={row.todayChangePct} />
                </TableCell>
                <TableCell>
                  <PctDeltaCell value={row.thirtyDayReturnPct} />
                </TableCell>
                <TableCell>
                  {row.weightPct != null ? `${row.weightPct.toFixed(1)}%` : '—'}
                </TableCell>
                <TableCell>
                  <PctDeltaCell value={row.totalReturnPct} />
                </TableCell>
                <TableCell>{row.accountBreakdown.length}</TableCell>
                <TableCell>
                  <Sparkline
                    data={(sparklines.get(row.securityId) ?? []).map((p) => ({
                      date: p.date,
                      value: p.close,
                    }))}
                  />
                </TableCell>
                <TableCell>
                  {row.latestPrice
                    ? `${formatMoney(row.latestPrice.price, row.latestPrice.currency)} · ${row.latestPrice.pricedAt.slice(0, 10)}`
                    : '—'}
                </TableCell>
              </TableRow>
            ))}
            {rows.length === 0 && (
              <EmptyTableRow
                colSpan={14}
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

type AllocBreakdownRow = {
  key: string
  group: string
  bucket: string
  currency: string
  marketValue: number
  percentage: number
}

type AllocSortField = 'group' | 'bucket' | 'marketValue' | 'percentage'

function AllocationPanel({ data }: { data: PortfolioAllocation | null }) {
  const [allocSort, setAllocSort] = useState<AllocSortField | null>(null)
  const [allocDir, setAllocDir] = useState<'asc' | 'desc'>('asc')

  const toggleAllocSort = useCallback((field: string) => {
    const f = field as AllocSortField
    if (allocSort !== f) {
      setAllocSort(f)
      setAllocDir('asc')
    } else if (allocDir === 'asc') {
      setAllocDir('desc')
    } else {
      setAllocSort(null)
      setAllocDir('asc')
    }
  }, [allocSort, allocDir])

  const empty =
    !data ||
    (data.byAssetType.length === 0 &&
      data.bySecurity.length === 0 &&
      data.byAccount.length === 0)

  const breakdownRows = useMemo<AllocBreakdownRow[]>(() => {
    if (!data) return []
    const rows: AllocBreakdownRow[] = [
      ...data.byAssetType.map((r) => ({
        key: `assetType|${r.assetType}|${r.currency}`,
        group: 'Asset type',
        bucket: `${r.assetType} (${r.currency})`,
        currency: r.currency,
        marketValue: r.marketValue,
        percentage: r.percentage,
      })),
      ...data.bySecurity.slice(0, 20).map((r) => ({
        key: `security|${r.securityId}|${r.currency}`,
        group: 'Security',
        bucket: `${r.symbol} (${r.currency})`,
        currency: r.currency,
        marketValue: r.marketValue,
        percentage: r.percentage,
      })),
      ...data.byAccount.map((r) => ({
        key: `account|${r.accountId}|${r.currency}`,
        group: 'Account',
        bucket: `${r.accountName} (${r.currency})`,
        currency: r.currency,
        marketValue: r.marketValue,
        percentage: r.percentage,
      })),
    ]
    if (!allocSort) return rows
    return [...rows].sort((a, b) => {
      const av = allocSort === 'marketValue' || allocSort === 'percentage' ? a[allocSort] : a[allocSort].toLowerCase()
      const bv = allocSort === 'marketValue' || allocSort === 'percentage' ? b[allocSort] : b[allocSort].toLowerCase()
      if (av < bv) return allocDir === 'asc' ? -1 : 1
      if (av > bv) return allocDir === 'asc' ? 1 : -1
      return 0
    })
  }, [data, allocSort, allocDir])

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
                <SortableTableHead field="group" currentSort={allocSort} dir={allocDir} onSort={toggleAllocSort}>Group</SortableTableHead>
                <SortableTableHead field="bucket" currentSort={allocSort} dir={allocDir} onSort={toggleAllocSort}>Bucket</SortableTableHead>
                <SortableTableHead field="marketValue" currentSort={allocSort} dir={allocDir} onSort={toggleAllocSort}>Market value</SortableTableHead>
                <SortableTableHead field="percentage" currentSort={allocSort} dir={allocDir} onSort={toggleAllocSort}>%</SortableTableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {breakdownRows.map((row) => (
                <TableRow key={row.key}>
                  <TableCell>{row.group}</TableCell>
                  <TableCell>{row.bucket}</TableCell>
                  <TableCell>{formatMoney(row.marketValue, row.currency)}</TableCell>
                  <TableCell>{safePct(row.percentage)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Card>
    </>
  )
}

/* ---------------------- Shared date-filter UI ---------------------- */

type DateFilterProps = {
  dateFrom: string
  dateTo: string
  onFromChange: (v: string) => void
  onToChange: (v: string) => void
}

function DateRangeFilter({ dateFrom, dateTo, onFromChange, onToChange }: DateFilterProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 mb-4">
      <label className="flex items-center gap-1 text-sm">
        <span className="text-muted-foreground">From</span>
        <input
          type="date"
          value={dateFrom}
          onChange={(e) => onFromChange(e.target.value)}
          className="border border-border bg-card rounded-md px-2 py-1 text-sm"
        />
      </label>
      <label className="flex items-center gap-1 text-sm">
        <span className="text-muted-foreground">To</span>
        <input
          type="date"
          value={dateTo}
          onChange={(e) => onToChange(e.target.value)}
          className="border border-border bg-card rounded-md px-2 py-1 text-sm"
        />
      </label>
    </div>
  )
}

/* ---------------------- Shared date-range data fetch ---------------------- */

function buildDateQuery(dateFrom: string, dateTo: string): string {
  const params = new URLSearchParams()
  if (dateFrom) params.set('dateFrom', dateFrom)
  if (dateTo) params.set('dateTo', dateTo)
  const qs = params.toString()
  return qs ? `?${qs}` : ''
}

type DateRangeFetchState<T> = {
  dateFrom: string
  dateTo: string
  setDateFrom: (v: string) => void
  setDateTo: (v: string) => void
  data: T | null
  loading: boolean
  err: string | null
}

function useDateRangeFetch<T>(endpoint: string, errorMessage: string): DateRangeFetchState<T> {
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const fetchData = useCallback(
    async (from: string, to: string) => {
      setLoading(true)
      setErr(null)
      try {
        const qs = buildDateQuery(from, to)
        const res = await getJson<T>(`${endpoint}${qs}`)
        setData(res)
      } catch (e) {
        setErr(e instanceof Error ? e.message : errorMessage)
      } finally {
        setLoading(false)
      }
    },
    [endpoint, errorMessage],
  )

  useEffect(() => {
    void fetchData(dateFrom, dateTo)
  }, [fetchData, dateFrom, dateTo])

  return { dateFrom, dateTo, setDateFrom, setDateTo, data, loading, err }
}

type DateRangePanelProps<T> = {
  state: DateRangeFetchState<T>
  isEmpty: (data: T) => boolean
  emptyMessage: string
  children: (data: T | null, loading: boolean) => ReactNode
}

function isPanelEmpty<T>(
  loading: boolean,
  data: T | null,
  isEmpty: (data: T) => boolean,
): boolean {
  if (loading) return false
  if (!data) return true
  return isEmpty(data)
}

function DateRangePanel<T>({ state, isEmpty, emptyMessage, children }: DateRangePanelProps<T>) {
  const { dateFrom, dateTo, setDateFrom, setDateTo, data, loading, err } = state
  if (err) return <p className="error">{err}</p>
  const filter = (
    <DateRangeFilter
      dateFrom={dateFrom}
      dateTo={dateTo}
      onFromChange={setDateFrom}
      onToChange={setDateTo}
    />
  )
  const body = isPanelEmpty(loading, data, isEmpty) ? (
    <Card>
      <p className="muted">{emptyMessage}</p>
    </Card>
  ) : (
    children(data, loading)
  )
  return (
    <>
      {filter}
      {body}
    </>
  )
}

/* ---------------------- Income tab ---------------------- */

function IncomePanel() {
  const state = useDateRangeFetch<PortfolioIncome>(
    '/api/portfolio/income',
    'Could not load income',
  )
  return (
    <DateRangePanel
      state={state}
      isEmpty={(d) => d.byMonth.length === 0 && d.totals.length === 0}
      emptyMessage="No dividend or interest activity yet. Import investment statements to populate this view."
    >
      {(data, loading) => <IncomeBody data={data} loading={loading} />}
    </DateRangePanel>
  )
}

function IncomeBody({ data, loading }: { data: PortfolioIncome | null; loading: boolean }) {
  if (!data) return <section className="transactionsStats" aria-busy={loading} />
  return (
    <>
      <section className="transactionsStats" aria-busy={loading}>
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

      <IncomeBySecurityTable rows={data.bySecurity} loading={loading} />
    </>
  )
}

type IncomeBySecurityRowData = PortfolioIncome['bySecurity'][number]

function IncomeBySecurityTable({
  rows,
  loading,
}: {
  rows: IncomeBySecurityRowData[]
  loading: boolean
}) {
  const showEmpty = !loading && rows.length === 0
  return (
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
            {rows.slice(0, 20).map((row) => (
              <IncomeBySecurityRow key={`${row.securityId ?? 'null'}|${row.currency}`} row={row} />
            ))}
            {showEmpty && (
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
  )
}

function IncomeBySecurityRow({ row }: { row: IncomeBySecurityRowData }) {
  return (
    <TableRow>
      <TableCell>
        <SymbolLink
          securityId={row.securityId}
          symbol={row.symbol}
          currency={row.currency}
        />
      </TableCell>
      <TableCell>{row.currency}</TableCell>
      <TableCell>{formatMoney(row.dividend, row.currency)}</TableCell>
      <TableCell>{formatMoney(row.interest, row.currency)}</TableCell>
      <TableCell>{formatMoney(row.total, row.currency)}</TableCell>
      <TableCell>{row.activityCount}</TableCell>
    </TableRow>
  )
}

function SymbolLink({
  securityId,
  symbol,
  name,
  assetType,
  currency,
}: {
  securityId: number | null
  symbol: string | null
  name?: string | null
  assetType?: string | null
  currency?: string | null
}) {
  if (securityId == null || !symbol) return <>{symbol ?? '—'}</>
  return (
    <span className="flex items-center gap-2">
      <SecurityLogo
        size="sm"
        symbol={symbol}
        name={name}
        assetType={assetType}
        currency={currency}
      />
      <Link
        to={`/portfolio/security/${securityId}`}
        className="text-foreground underline-offset-2 hover:underline"
      >
        {symbol}
      </Link>
    </span>
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

function RealizedPanel() {
  const state = useDateRangeFetch<PortfolioRealized>(
    '/api/portfolio/realized',
    'Could not load realized P&L',
  )
  return (
    <DateRangePanel
      state={state}
      isEmpty={(d) => d.events.length === 0}
      emptyMessage="No realized SELL events yet. Realized gain/loss appears here after a sell activity is imported."
    >
      {(data, loading) => <RealizedBody data={data} loading={loading} />}
    </DateRangePanel>
  )
}

type RealizedEvent = PortfolioRealized['events'][number]
type RealizedEventWithRunning = RealizedEvent & { runningTotal: number }
type RealizedBySecurityRowData = PortfolioRealized['bySecurity'][number]

function withRunningTotal(events: RealizedEvent[]): RealizedEventWithRunning[] {
  const runningByCurrency = new Map<string, number>()
  return events.map((ev) => {
    const prev = runningByCurrency.get(ev.currency) ?? 0
    const next = prev + ev.realizedGain
    runningByCurrency.set(ev.currency, next)
    return { ...ev, runningTotal: next }
  })
}

function RealizedBody({
  data,
  loading,
}: {
  data: PortfolioRealized | null
  loading: boolean
}) {
  if (!data) return <section className="transactionsStats" aria-busy={loading} />
  const eventsWithRunning = withRunningTotal(data.events)
  return (
    <>
      <RealizedTotalsSection totals={data.totals} loading={loading} />
      <RealizedBySecurityTable rows={data.bySecurity} />
      <RealizedEventsTable events={eventsWithRunning} />
    </>
  )
}

function RealizedTotalsSection({
  totals,
  loading,
}: {
  totals: PortfolioRealized['totals']
  loading: boolean
}) {
  return (
    <section className="transactionsStats" aria-busy={loading}>
      {totals.map((row) => (
        <StatCard
          key={row.currency}
          label={`${row.currency} realized to date`}
          value={formatMoney(row.realizedGain, row.currency)}
          hint={`${row.eventCount} sell event${row.eventCount === 1 ? '' : 's'}`}
        />
      ))}
    </section>
  )
}

function RealizedBySecurityTable({ rows }: { rows: RealizedBySecurityRowData[] }) {
  return (
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
            {rows.map((row) => (
              <TableRow key={`${row.securityId}|${row.currency}`}>
                <TableCell>
                  <SymbolLink
                    securityId={row.securityId}
                    symbol={row.symbol}
                    name={row.name}
                    currency={row.currency}
                  />
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
  )
}

function RealizedEventsTable({ events }: { events: RealizedEventWithRunning[] }) {
  return (
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
            {events.map((ev) => (
              <TableRow key={ev.activityId}>
                <TableCell>{ev.tradeDate}</TableCell>
                <TableCell>{ev.accountName}</TableCell>
                <TableCell>
                  <SymbolLink
                    securityId={ev.securityId}
                    symbol={ev.symbol}
                    currency={ev.currency}
                  />
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
  )
}

