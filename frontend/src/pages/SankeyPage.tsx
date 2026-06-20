import { useCallback, useEffect, useMemo, useState } from 'react'
import { Rectangle, ResponsiveContainer, Sankey, Tooltip } from 'recharts'
import { Alert } from '@connor-adams/designsystem'
import { Button } from '@connor-adams/designsystem'
import { Card, CardContent, CardHeader, CardTitle } from '@connor-adams/designsystem'
import { Dialog } from '@connor-adams/designsystem'
import { EmptyState } from '@connor-adams/designsystem'
import { FilterBar, type QuickRange } from '@/components/ui/filter-bar'
import { PageHeader } from '@/components/ui/page-header'
import { StatCard } from '@connor-adams/designsystem'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@connor-adams/designsystem'
import { getJson } from '../lib/api'
import {
  fromDateInputValue,
  getRelativeDateRange,
  toDateInputValue,
  todayDateInputValue,
} from '../lib/dateInput'
import { formatMoney } from '../lib/formatMoney'
import { summaryQueryString } from '../lib/summaryQuery'
import { useSessionState } from '../lib/useSessionState'
import type {
  SankeyDrilldownResponse,
  SankeyDrilldownTransaction,
  SankeyNode as SankeyNodeType,
  SankeyResponse,
} from '../types/api'

const DEFAULT_CURRENCY = 'CAD'

/**
 * Color lookup keyed by the backend `kind`. Tailwind v4 JIT requires
 * literal class names (lookup tables, not concatenation), so we map
 * directly here. SVG fills come from the same swatches the dashboard's
 * recharts components use so the Sankey feels like the rest of the app.
 */
const NODE_COLORS: Record<SankeyNodeType['kind'], string> = {
  income: 'var(--chart-income)',
  category: 'var(--chart-category)',
  business: 'var(--chart-business-alt)',
  savings: 'var(--chart-savings)',
  uncategorized: 'var(--chart-uncategorized)',
}

/**
 * UTC midnight of the user's local calendar day — used as the anchor for
 * relative quick-range buttons. Matches the pattern from PartnerFairnessPage.
 */
function localTodayUtcMidnight(): Date {
  const value = fromDateInputValue(todayDateInputValue())
  // fromDateInputValue returns null only when the string isn't parseable;
  // `todayDateInputValue()` always produces a valid YYYY-MM-DD, so the null
  // branch is defensive.
  return value ?? new Date()
}

function getYearToDate(): { from: string; to: string } {
  const to = localTodayUtcMidnight()
  const from = new Date(Date.UTC(to.getUTCFullYear(), 0, 1))
  return { from: toDateInputValue(from), to: toDateInputValue(to) }
}

const QUICK_RANGES: QuickRange[] = [
  { key: '30d', label: 'Last 30 days', ...getRelativeDateRange(30) },
  { key: '90d', label: 'Last 90 days', ...getRelativeDateRange(90) },
  { key: 'ytd', label: 'Year to date', ...getYearToDate() },
  { key: '365d', label: 'Last 12 months', ...getRelativeDateRange(365) },
  { key: 'all', label: 'All time', from: '', to: '' },
]

/**
 * /sankey — Cashflow visualization (issue #224). Single-currency Sankey
 * showing how income flows into the household's category buckets and
 * business spending. Internal transfers / investment buys are excluded
 * upstream so the chart reflects true consumption + income, not money
 * movement.
 */
export function SankeyPage() {
  const [currency, setCurrency] = useSessionState(
    'sankey.currency',
    DEFAULT_CURRENCY,
  )
  const [dateFrom, setDateFrom] = useSessionState('sankey.dateFrom', '')
  const [dateTo, setDateTo] = useSessionState('sankey.dateTo', '')
  const [data, setData] = useState<SankeyResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [drill, setDrill] = useState<{
    edge: { source: number; target: number }
    label: string
  } | null>(null)
  const [drillRows, setDrillRows] = useState<SankeyDrilldownTransaction[]>([])
  const [drillLoading, setDrillLoading] = useState(false)
  const [drillTotalCount, setDrillTotalCount] = useState(0)
  const [drillTruncated, setDrillTruncated] = useState(false)
  const [drillErr, setDrillErr] = useState<string | null>(null)

  const refetch = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const qs = summaryQueryString({ currency, dateFrom, dateTo })
      const json = await getJson<SankeyResponse>(`/api/summary/sankey${qs}`)
      setData(json)
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to load Sankey'
      setErr(message)
    } finally {
      setLoading(false)
    }
  }, [currency, dateFrom, dateTo])

  useEffect(() => {
    void refetch()
  }, [refetch])

  const onDateChange = useCallback(
    (from: string, to: string) => {
      setDateFrom(from)
      setDateTo(to)
    },
    [setDateFrom, setDateTo],
  )

  // Recharts mutates its `data` prop during layout; pass a deep clone so
  // React's reconciliation doesn't observe in-place mutations as upstream
  // state churn.
  const sankeyData = useMemo(() => {
    if (!data || data.nodes.length === 0) return null
    return {
      nodes: data.nodes.map((n) => ({ ...n })),
      links: data.links.map((l) => ({ ...l })),
    }
  }, [data])

  // Open the drill-down dialog for the clicked link. Source/target are
  // node indices into the chart's node array.
  const onLinkClick = useCallback(
    async (source: number, target: number) => {
      if (!data) return
      const sourceName = data.nodes[source]?.name ?? `Node ${source}`
      const targetName = data.nodes[target]?.name ?? `Node ${target}`
      const label = `${sourceName} → ${targetName}`
      setDrill({ edge: { source, target }, label })
      setDrillRows([])
      setDrillTotalCount(0)
      setDrillTruncated(false)
      setDrillErr(null)
      setDrillLoading(true)
      try {
        const qs = summaryQueryString({ currency, dateFrom, dateTo })
        const sep = qs.length > 0 ? '&' : '?'
        const json = await getJson<SankeyDrilldownResponse>(
          `/api/summary/sankey/source-transactions${qs}${sep}source=${source}&target=${target}`,
        )
        setDrillRows(json.transactions)
        setDrillTotalCount(json.transactionCount)
        setDrillTruncated(json.truncated)
      } catch (e) {
        setDrillErr(e instanceof Error ? e.message : 'Failed to load drill-down')
      } finally {
        setDrillLoading(false)
      }
    },
    [currency, dateFrom, dateTo, data],
  )

  const closeDrill = useCallback(() => {
    setDrill(null)
    setDrillRows([])
    setDrillTotalCount(0)
    setDrillTruncated(false)
    setDrillErr(null)
  }, [])

  const headlineNodes = useMemo(() => data?.nodes ?? [], [data])
  const showEmpty =
    !loading &&
    !err &&
    (sankeyData === null || (data?.totalIncome === 0 && data?.totalSpend === 0))

  return (
    <div className="page">
      <PageHeader
        title="Cashflow"
        description="See how money moves from income into your spending categories and savings. Click any flow to inspect the source transactions."
      />

      <FilterBar
        currency={currency}
        onCurrencyChange={setCurrency}
        availableCurrencies={data?.availableCurrencies}
        allowAllCurrencies={false}
        dateFrom={dateFrom}
        dateTo={dateTo}
        onDateChange={onDateChange}
        quickRanges={QUICK_RANGES}
        quickRangesLabel="Sankey date range"
      />

      {err ? (
        <Alert variant="error" className="mt-4">
          {err}
        </Alert>
      ) : null}

      <section className="mt-4 grid gap-3 sm:grid-cols-3">
        <StatCard
          label="Total income"
          value={data ? formatMoney(data.totalIncome, currency) : '—'}
          hint={
            <>
              Money labelled <code>income</code> for this currency + date
              range.
            </>
          }
        />
        <StatCard
          label="Total spend"
          value={data ? formatMoney(data.totalSpend, currency) : '—'}
          hint="Sum of category outflows after refund netting. Excludes transfers, investments, and dividends."
        />
        <StatCard
          label="Transactions"
          value={data ? data.transactionCount : '—'}
          hint="Rows that contributed to the chart (post-filter)."
        />
      </section>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Flow</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm leading-6 text-muted-foreground">Loading…</p>
          ) : showEmpty ? (
            <EmptyState
              title="No flows for this filter"
              description="Try a wider date range or pick a different currency. The chart needs at least one income or category-tagged transaction to draw."
            />
          ) : sankeyData ? (
            <div style={{ width: '100%', height: 520 }}>
              <ResponsiveContainer width="100%" height="100%">
                <Sankey
                  data={sankeyData}
                  nodePadding={28}
                  nodeWidth={14}
                  iterations={64}
                  node={(props) => (
                    <SankeyNode
                      {...props}
                      kinds={headlineNodes.map((n) => n.kind)}
                    />
                  )}
                  link={(props) => (
                    <SankeyLinkPath
                      {...props}
                      onLinkClick={onLinkClick}
                    />
                  )}
                >
                  <Tooltip
                    formatter={(value) => {
                      const n = typeof value === 'number' ? value : Number(value)
                      return Number.isFinite(n)
                        ? formatMoney(n, currency)
                        : String(value)
                    }}
                  />
                </Sankey>
              </ResponsiveContainer>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {drill ? (
        <Dialog
          open
          onClose={closeDrill}
          title={<>{drill.label}</>}
          footer={
            <>
              <Button type="button" variant="outline" onClick={closeDrill}>
                Close
              </Button>
            </>
          }
        >
            {drillErr ? (
              <p
                role="alert"
                className="text-sm leading-6 text-muted-foreground"
              >
                {drillErr}
              </p>
            ) : drillLoading ? (
              <p className="text-sm leading-6 text-muted-foreground">
                Loading transactions…
              </p>
            ) : drillRows.length === 0 ? (
              <EmptyState
                title="No source transactions"
                description="The flow exists in the chart but no underlying rows were returned. Refresh and try again."
              />
            ) : (
              <>
                <p className="mb-2 text-sm leading-6 text-muted-foreground">
                  {drillTotalCount.toLocaleString()} transaction
                  {drillTotalCount === 1 ? '' : 's'} contributed to this flow.
                  {drillTruncated
                    ? ' Showing the most recent 500 — refine the date range to see fewer.'
                    : ''}
                </p>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Merchant</TableHead>
                      <TableHead>Category</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {drillRows.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell>{row.date}</TableCell>
                        <TableCell>{row.merchant}</TableCell>
                        <TableCell>
                          {row.finalCategory ?? (
                            <span className="text-xs text-muted-foreground">
                              Uncategorized
                            </span>
                          )}
                          {row.finalBusiness ? (
                            <span className="text-xs text-muted-foreground">
                              {' '}
                              (business)
                            </span>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-right">
                          {formatMoney(row.amount, row.currency)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </>
            )}
        </Dialog>
      ) : null}
    </div>
  )
}

// ---- Custom node renderer ---------------------------------------------

type NodeRendererProps = {
  x: number
  y: number
  width: number
  height: number
  index: number
  payload: { name?: string; value?: number }
  kinds: SankeyNodeType['kind'][]
}

function SankeyNode({
  x,
  y,
  width,
  height,
  index,
  payload,
  kinds,
}: NodeRendererProps) {
  const kind = kinds[index] ?? 'category'
  const fill = NODE_COLORS[kind] ?? NODE_COLORS.category
  const labelOnRight = index === 0
  const labelX = labelOnRight ? x + width + 8 : x - 8
  const textAnchor = labelOnRight ? 'start' : 'end'
  const labelY = y + height / 2
  return (
    <g>
      <Rectangle
        x={x}
        y={y}
        width={width}
        height={height}
        fill={fill}
        fillOpacity={0.95}
        stroke="var(--chart-link-stroke)"
        strokeOpacity={0.2}
      />
      <text
        textAnchor={textAnchor}
        x={labelX}
        y={labelY}
        dy="0.35em"
        fontSize={12}
        className="fill-foreground"
      >
        {payload.name}
      </text>
    </g>
  )
}

// ---- Custom link renderer ---------------------------------------------

type LinkRendererProps = {
  sourceX: number
  targetX: number
  sourceY: number
  targetY: number
  sourceControlX: number
  targetControlX: number
  linkWidth: number
  index: number
  payload: {
    source: number | { name?: string; sourceLinks?: unknown[]; targetLinks?: unknown[] }
    target: number | { name?: string; sourceLinks?: unknown[]; targetLinks?: unknown[] }
    value: number
  }
  onLinkClick: (source: number, target: number) => void
}

/**
 * Custom link renderer that:
 *   - Draws the recharts-default bezier path
 *   - Routes onClick → opens the drill-down dialog
 *
 * Recharts mutates link.source/target into node objects after layout;
 * we recover the indices from the rendered payload via the order the
 * nodes appear in the chart. Because the parent passes the same node
 * array we control, source/target start as numbers and stay accessible
 * via `.payload` keys 'index' on the recovered objects in newer recharts.
 * We fall back to recovering by scanning the nodes array via `name`.
 */
function SankeyLinkPath({
  sourceX,
  targetX,
  sourceY,
  targetY,
  sourceControlX,
  targetControlX,
  linkWidth,
  payload,
  onLinkClick,
}: LinkRendererProps) {
  const d = `M${sourceX},${sourceY}C${sourceControlX},${sourceY} ${targetControlX},${targetY} ${targetX},${targetY}`
  const handleClick = () => {
    const source = resolveLinkEnd(payload.source)
    const target = resolveLinkEnd(payload.target)
    if (source == null || target == null) return
    onLinkClick(source, target)
  }
  return (
    <path
      d={d}
      fill="none"
      stroke="var(--chart-category)"
      strokeOpacity={0.35}
      strokeWidth={linkWidth}
      onClick={handleClick}
      style={{ cursor: 'pointer' }}
      data-testid="sankey-link"
    />
  )
}

function resolveLinkEnd(
  end: number | { index?: number; name?: string },
): number | null {
  if (typeof end === 'number') return end
  if (end && typeof end.index === 'number') return end.index
  return null
}
