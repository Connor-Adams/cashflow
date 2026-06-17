import { useCallback, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { AlertTriangle, ArrowDownRight, ArrowUpRight, Calendar } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/ui/page-header'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useToast } from '@/components/ui/toast'
import { formatMoney } from '../lib/formatMoney'
import {
  FORECAST_RANGE_LABEL,
  useForecast,
  type ForecastRange,
} from '../hooks/useForecast'
import type {
  ForecastEvent,
  ForecastEventDirection,
  PlannedEvent,
  PlannedEventPatch,
  PlannedEventStatus,
} from '../types/api'

const RANGE_ORDER: ForecastRange[] = ['7d', '30d', '90d']

// Tailwind v4 JIT needs literal classes, so we look up colours per direction
// via a table rather than building strings dynamically.
const DIRECTION_TONE: Record<ForecastEventDirection, string> = {
  in: 'text-positive',
  out: 'text-negative',
  neutral: 'text-muted-foreground',
}

const DIRECTION_PREFIX: Record<ForecastEventDirection, string> = {
  in: '+',
  out: '−',
  neutral: '±',
}

/**
 * Wrapper for PUT /api/planned-events/:id used to mark a row as paid /
 * skipped from the upcoming list. Mirrors the helper in
 * PlannedEventsPage.tsx (shared lib/api.ts has no PUT helper today).
 */
async function putPlannedEvent(
  id: number,
  body: PlannedEventPatch,
): Promise<PlannedEvent> {
  const base = import.meta.env.VITE_API_BASE ?? ''
  const res = await fetch(`${base}/api/planned-events/${id}`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    let message = res.statusText
    const raw = await res.text()
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { error?: string }
        message = parsed.error ?? raw
      } catch {
        message = raw
      }
    }
    throw new Error(message)
  }
  return (await res.json()) as PlannedEvent
}

function eventKey(e: ForecastEvent): string {
  return `${e.sourceType}-${e.sourceId}-${e.date}`
}

function buildEventDescription(e: ForecastEvent): string {
  if (e.sourceType === 'recurring_detection') {
    return e.direction === 'in' ? 'Recurring income (detected)' : 'Recurring (detected)'
  }
  return 'Planned event'
}

export function ForecastPage() {
  const { showToast } = useToast()
  const [range, setRange] = useState<ForecastRange>('30d')
  const [pendingId, setPendingId] = useState<number | null>(null)

  const { data, loading, error, refresh } = useForecast({ range })

  const currency = data?.currency ?? 'CAD'

  const totalIn = useMemo(() => {
    if (!data) return 0
    return data.events
      .filter((e) => e.direction === 'in')
      .reduce((acc, e) => acc + e.amount, 0)
  }, [data])

  const totalOut = useMemo(() => {
    if (!data) return 0
    return data.events
      .filter((e) => e.direction === 'out')
      .reduce((acc, e) => acc + e.amount, 0)
  }, [data])

  const chartData = useMemo(() => {
    if (!data) return []
    return data.dailyPoints.map((p) => ({ date: p.date, balance: p.balance }))
  }, [data])

  const goesBelowZero = (data?.lowestProjectedBalance ?? 0) < 0

  /**
   * Update a planned-event row's status (posted | skipped) and refresh
   * the forecast. The forecast endpoint excludes posted/skipped events
   * from projection so the chart updates as soon as the call returns.
   * Recurring-detection rows have no row id we can mutate — for those
   * we just hide the action.
   */
  const updateStatus = useCallback(
    async (id: number, status: PlannedEventStatus) => {
      setPendingId(id)
      try {
        await putPlannedEvent(id, { status })
        refresh()
        showToast({
          title:
            status === 'posted'
              ? 'Marked as paid'
              : status === 'skipped'
                ? 'Marked as skipped'
                : 'Updated',
        })
      } catch (e) {
        showToast({
          title: 'Could not update event',
          description: e instanceof Error ? e.message : String(e),
          variant: 'destructive',
        })
      } finally {
        setPendingId(null)
      }
    },
    [refresh, showToast],
  )

  return (
    <div className="page">
      <PageHeader
        title="Forecast"
        description="Projected cashflow combining your planned events and detected recurring charges."
        actions={
          <div className="flex flex-wrap gap-2" role="group" aria-label="Forecast range">
            {RANGE_ORDER.map((r) => (
              <Button
                key={r}
                size="sm"
                variant={r === range ? 'default' : 'outline'}
                onClick={() => setRange(r)}
                aria-pressed={r === range}
              >
                {FORECAST_RANGE_LABEL[r]}
              </Button>
            ))}
          </div>
        }
      />

      {error ? (
        <EmptyState
          title="Could not load forecast"
          description={error.message}
          actions={
            <Button size="sm" variant="outline" onClick={refresh}>
              Retry
            </Button>
          }
        />
      ) : null}

      {/* Summary tiles */}
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryTile
          label="Opening balance"
          value={data ? formatMoney(data.openingBalance, currency) : '—'}
          loading={loading}
        />
        <SummaryTile
          label="Projected closing"
          value={data ? formatMoney(data.projectedClosingBalance, currency) : '—'}
          loading={loading}
        />
        <SummaryTile
          label="Lowest projected"
          value={data ? formatMoney(data.lowestProjectedBalance, currency) : '—'}
          description={
            data?.lowestProjectedBalanceDate
              ? `on ${data.lowestProjectedBalanceDate}`
              : undefined
          }
          tone={goesBelowZero ? 'warn' : 'default'}
          loading={loading}
        />
        <SummaryTile
          label="Net change"
          value={
            data
              ? formatMoney(
                  data.projectedClosingBalance - data.openingBalance,
                  currency,
                )
              : '—'
          }
          description={
            data ? `${formatMoney(totalIn, currency)} in / ${formatMoney(totalOut, currency)} out` : undefined
          }
          loading={loading}
        />
      </div>

      {/* Lowest-balance warning */}
      {goesBelowZero && data ? (
        <Card className="mb-4 border-amber-300 bg-warning-bg p-4 dark:border-amber-700">
          <div className="flex gap-3">
            <AlertTriangle
              className="mt-0.5 size-5 shrink-0 text-warning"
              aria-hidden="true"
            />
            <div>
              <p className="font-semibold text-warning-foreground">
                Balance dips below {formatMoney(0, currency)}
              </p>
              <p className="mb-0 text-sm text-warning">
                Projected to reach {formatMoney(data.lowestProjectedBalance, currency)} on{' '}
                {data.lowestProjectedBalanceDate}. Consider shifting expenses or planning a transfer.
              </p>
            </div>
          </div>
        </Card>
      ) : null}

      {/* Chart */}
      <Card className="mb-4 p-3">
        <h2 className="mb-2 text-sm font-semibold">Projected balance</h2>
        <div style={{ width: '100%', height: 320 }}>
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient id="forecastFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--chart-income)" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="var(--chart-income)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 11 }}
                  minTickGap={32}
                />
                <YAxis
                  width={72}
                  tick={{ fontSize: 11 }}
                  tickFormatter={(value: number) => formatMoney(value, currency)}
                />
                <Tooltip
                  formatter={(value) => {
                    const v = typeof value === 'number' ? value : Number(value)
                    return Number.isFinite(v) ? formatMoney(v, currency) : ''
                  }}
                  labelFormatter={(label) => (typeof label === 'string' ? label : String(label ?? ''))}
                />
                <ReferenceLine y={0} stroke="var(--chart-danger-line)" strokeDasharray="4 4" />
                <Area
                  type="monotone"
                  dataKey="balance"
                  stroke="var(--chart-income-stroke)"
                  fill="url(#forecastFill)"
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="grid h-full place-items-center">
              <p className="muted">
                {loading ? 'Loading forecast…' : 'No projection available.'}
              </p>
            </div>
          )}
        </div>
      </Card>

      {/* Upcoming list */}
      <Card className="p-3">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Upcoming inflows &amp; outflows</h2>
          {data ? (
            <Badge variant="secondary" className="text-xs">
              <Calendar className="mr-1 size-3" aria-hidden="true" />
              {data.dateFrom} → {data.dateTo}
            </Badge>
          ) : null}
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Event</TableHead>
              <TableHead>Source</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data && data.events.length > 0 ? (
              data.events.map((e) => (
                <TableRow key={eventKey(e)}>
                  <TableCell className="whitespace-nowrap">{e.date}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      {e.direction === 'in' ? (
                        <ArrowUpRight
                          className="size-4 text-positive"
                          aria-hidden="true"
                        />
                      ) : e.direction === 'out' ? (
                        <ArrowDownRight
                          className="size-4 text-negative"
                          aria-hidden="true"
                        />
                      ) : null}
                      <span>{e.sourceName}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-xs muted">
                    {buildEventDescription(e)}
                  </TableCell>
                  <TableCell
                    className={`text-right whitespace-nowrap ${DIRECTION_TONE[e.direction]}`}
                  >
                    {DIRECTION_PREFIX[e.direction]}
                    {formatMoney(e.amount, currency)}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    {e.sourceType === 'planned_event' ? (
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={pendingId === e.sourceId}
                          onClick={() => updateStatus(e.sourceId, 'posted')}
                        >
                          Paid
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={pendingId === e.sourceId}
                          onClick={() => updateStatus(e.sourceId, 'skipped')}
                        >
                          Skip
                        </Button>
                      </div>
                    ) : (
                      <span className="muted text-xs">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={5}>
                  <EmptyState
                    title="No upcoming events"
                    description={
                      loading
                        ? 'Loading…'
                        : 'Add a planned event or wait until recurring charges are detected.'
                    }
                    actions={
                      !loading && (
                        <div className="flex gap-2 flex-wrap justify-center">
                          <Button size="sm" asChild>
                            <Link to="/planned">Add planned event</Link>
                          </Button>
                          <Button size="sm" variant="outline" asChild>
                            <Link to="/recurring">View recurring</Link>
                          </Button>
                        </div>
                      )
                    }
                  />
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  )
}

type SummaryTileProps = {
  label: string
  value: string
  description?: string
  tone?: 'default' | 'warn'
  loading?: boolean
}

function SummaryTile({ label, value, description, tone, loading }: SummaryTileProps) {
  return (
    <Card className="p-3">
      <p className="muted mb-1 text-xs uppercase tracking-wide">{label}</p>
      <p
        className={`mb-0 text-lg font-semibold tabular-nums ${
          tone === 'warn' ? 'text-warning' : ''
        }`}
      >
        {loading ? '…' : value}
      </p>
      {description ? <p className="muted mb-0 text-xs">{description}</p> : null}
    </Card>
  )
}
