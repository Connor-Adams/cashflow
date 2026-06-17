/**
 * Monthly Close (issue #227).
 *
 * Surface a month-end checklist that walks the user through reconciling
 * the financial period. Each task carries a deep link back to the page
 * that handles its work (Import, Review inbox, Receipts, Settlements,
 * Tax reserve, Net worth, Reports). The current state of critical items
 * is shown so the user can decide whether to close or force-close.
 *
 * State machine for a period:
 *   not-started → POST /start → open → PATCH tasks → POST /close → closed
 *                                                  ↘ POST /reopen ↗
 *
 * Backend endpoint is /api/monthly-close (see backend/src/routes/monthlyClose.ts).
 * The page deliberately keeps the JSON shape and rendering naive — the
 * checklist is small enough that no virtualisation, paging, or memoised
 * derived state is warranted.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Circle, Lock, Unlock } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Label } from '@/components/ui/label'
import { PageHeader } from '@/components/ui/page-header'
import { useToast } from '@/components/ui/toast'
import { getJson, patchJson, postJson } from '@/lib/api'

// ---- Shared types (mirror backend serializers) ------------------------

type MonthlyCloseStatus = 'open' | 'closed'

type MonthlyCloseTaskKey =
  | 'imports'
  | 'review_inbox'
  | 'receipts'
  | 'settlements'
  | 'taxes'
  | 'net_worth'
  | 'reports'

type PeriodResponse = {
  id: number
  householdId: number
  userId: number
  periodMonth: string
  status: MonthlyCloseStatus
  openedAt: string
  closedAt: string | null
  notes: string | null
  createdAt: string
  updatedAt: string
}

type TaskResponse = {
  id: number
  periodId: number
  taskKey: MonthlyCloseTaskKey
  isComplete: boolean
  completedAt: string | null
  completedByUserId: number | null
  notes: string | null
  sortOrder: number
  createdAt: string
  updatedAt: string
}

type CriticalSummary = {
  counts: {
    unreviewedTransactions: number
    outstandingPartnerBuckets: number
  }
  reasons: Array<'unreviewed_transactions' | 'outstanding_partner_balance'>
  hasCritical: boolean
}

type PeriodDetailResponse = {
  period: PeriodResponse | null
  tasks: TaskResponse[]
  critical: CriticalSummary
}

type PeriodListResponse = { data: PeriodResponse[] }

// ---- Static UI metadata, keyed by task -------------------------------

type TaskUiMeta = {
  title: string
  description: string
  deepLink: string
}

/**
 * Map task key → display strings and deep link. The backend supplies
 * the canonical title/description in the task spec; we keep a duplicate
 * here so a future tweak to wording lands in one place per surface.
 */
const TASK_META: Record<MonthlyCloseTaskKey, TaskUiMeta> = {
  imports: {
    title: 'Import statements',
    description: 'Pull this month’s statements and exports into Cashflow.',
    deepLink: '/import',
  },
  review_inbox: {
    title: 'Review uncategorised transactions',
    description:
      'Triage the review inbox so every transaction has a final category.',
    deepLink: '/review',
  },
  receipts: {
    title: 'Attach receipts to large purchases',
    description:
      'Pair receipts with their transactions for taxes and item-level detail.',
    deepLink: '/transactions',
  },
  settlements: {
    title: 'Settle partner balances',
    description:
      'Record any settlements so the partner balance reflects reality.',
    deepLink: '/partner',
  },
  taxes: {
    title: 'Reserve taxes',
    description:
      'Set aside money for income, sales, and corporate taxes accrued this month.',
    deepLink: '/tax',
  },
  net_worth: {
    title: 'Snapshot net worth',
    description:
      'Capture this month’s net worth and refresh any manual holdings.',
    deepLink: '/net-worth',
  },
  reports: {
    title: 'Review the month',
    description:
      'Skim the reports and dashboard summary to spot anomalies and wins.',
    deepLink: '/reports',
  },
}

// ---- Helpers --------------------------------------------------------

/** Format 'YYYY-MM' as a long human-readable month + year. */
function formatMonthLabel(periodMonth: string): string {
  if (!/^\d{4}-\d{2}$/.test(periodMonth)) return periodMonth
  const [yearStr, monthStr] = periodMonth.split('-')
  const date = new Date(Number(yearStr), Number(monthStr) - 1, 1)
  return date.toLocaleString(undefined, { month: 'long', year: 'numeric' })
}

/** YYYY-MM of the current calendar month (in the user's local timezone). */
function currentPeriodMonth(): string {
  const now = new Date()
  const y = now.getFullYear().toString().padStart(4, '0')
  const m = (now.getMonth() + 1).toString().padStart(2, '0')
  return `${y}-${m}`
}

/** YYYY-MM of the month prior to `periodMonth`. */
function previousPeriodMonth(periodMonth: string): string {
  if (!/^\d{4}-\d{2}$/.test(periodMonth)) return currentPeriodMonth()
  const [yearStr, monthStr] = periodMonth.split('-')
  const year = Number(yearStr)
  const month = Number(monthStr)
  const prevMonth = month === 1 ? 12 : month - 1
  const prevYear = month === 1 ? year - 1 : year
  return `${prevYear.toString().padStart(4, '0')}-${prevMonth
    .toString()
    .padStart(2, '0')}`
}

/** YYYY-MM of the month after `periodMonth`. */
function nextPeriodMonth(periodMonth: string): string {
  if (!/^\d{4}-\d{2}$/.test(periodMonth)) return currentPeriodMonth()
  const [yearStr, monthStr] = periodMonth.split('-')
  const year = Number(yearStr)
  const month = Number(monthStr)
  const nMonth = month === 12 ? 1 : month + 1
  const nYear = month === 12 ? year + 1 : year
  return `${nYear.toString().padStart(4, '0')}-${nMonth.toString().padStart(2, '0')}`
}

// ---- Component ------------------------------------------------------

export function MonthlyClosePage() {
  const { showToast } = useToast()
  const [periodMonth, setPeriodMonth] = useState<string>(() =>
    previousPeriodMonth(currentPeriodMonth()),
  )
  const [detail, setDetail] = useState<PeriodDetailResponse | null>(null)
  const [history, setHistory] = useState<PeriodResponse[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const monthLabel = useMemo(() => formatMonthLabel(periodMonth), [periodMonth])

  const fetchDetail = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const r = await getJson<PeriodDetailResponse>(
        `/api/monthly-close/${periodMonth}`,
      )
      setDetail(r)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load close period')
    } finally {
      setLoading(false)
    }
  }, [periodMonth])

  const fetchHistory = useCallback(async () => {
    try {
      const r = await getJson<PeriodListResponse>('/api/monthly-close')
      setHistory(r.data)
    } catch {
      // Non-fatal — empty list is the worst-case render.
      setHistory([])
    }
  }, [])

  useEffect(() => {
    void fetchDetail()
  }, [fetchDetail])

  useEffect(() => {
    void fetchHistory()
  }, [fetchHistory])

  const startClose = useCallback(async () => {
    setBusy(true)
    setErr(null)
    try {
      const r = await postJson<PeriodDetailResponse>(
        `/api/monthly-close/${periodMonth}/start`,
      )
      setDetail(r)
      await fetchHistory()
      showToast({ title: 'Monthly close started', variant: 'success' })
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to start close'
      setErr(msg)
      showToast({ title: msg, variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }, [periodMonth, fetchHistory, showToast])

  const toggleTask = useCallback(
    async (taskKey: MonthlyCloseTaskKey, next: boolean) => {
      if (!detail || detail.period == null) return
      setBusy(true)
      setErr(null)
      try {
        const updated = await patchJson<TaskResponse>(
          `/api/monthly-close/${periodMonth}/tasks/${taskKey}`,
          { isComplete: next },
        )
        setDetail((prev) =>
          prev
            ? {
                ...prev,
                tasks: prev.tasks.map((t) => (t.id === updated.id ? updated : t)),
              }
            : prev,
        )
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Failed to update task'
        setErr(msg)
        showToast({ title: msg, variant: 'destructive' })
      } finally {
        setBusy(false)
      }
    },
    [detail, periodMonth, showToast],
  )

  const closeMonth = useCallback(
    async (force: boolean) => {
      if (!detail || detail.period == null) return
      setBusy(true)
      setErr(null)
      try {
        const r = await postJson<PeriodDetailResponse>(
          `/api/monthly-close/${periodMonth}/close`,
          { force },
        )
        setDetail(r)
        await fetchHistory()
        showToast({ title: `Closed ${monthLabel}`, variant: 'success' })
      } catch (e) {
        const msg =
          e instanceof Error ? e.message : 'Failed to close month'
        setErr(msg)
        // 409 critical_items surface — the message comes through verbatim.
        showToast({ title: msg, variant: 'destructive' })
      } finally {
        setBusy(false)
      }
    },
    [detail, periodMonth, fetchHistory, monthLabel, showToast],
  )

  const reopenMonth = useCallback(async () => {
    if (!detail || detail.period == null) return
    setBusy(true)
    setErr(null)
    try {
      const r = await postJson<PeriodDetailResponse>(
        `/api/monthly-close/${periodMonth}/reopen`,
      )
      setDetail(r)
      await fetchHistory()
      showToast({ title: `Reopened ${monthLabel}`, variant: 'success' })
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to reopen month'
      setErr(msg)
      showToast({ title: msg, variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }, [detail, periodMonth, fetchHistory, monthLabel, showToast])

  const completed = useMemo(() => {
    if (!detail) return 0
    return detail.tasks.filter((t) => t.isComplete).length
  }, [detail])

  const total = detail?.tasks.length ?? 0
  const isStarted = Boolean(detail?.period)
  const isClosed = detail?.period?.status === 'closed'

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Monthly close · ${monthLabel}`}
        description="Walk the checklist that gets each month reconciled, settled, and snapshotted."
      />

      {/* Month picker — prev / current input / next */}
      <Card className="p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="period-month">Period</Label>
            <input
              id="period-month"
              type="month"
              value={periodMonth}
              onChange={(e) => setPeriodMonth(e.target.value)}
              className="rounded border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setPeriodMonth(previousPeriodMonth(periodMonth))}
              disabled={busy}
            >
              Previous month
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setPeriodMonth(nextPeriodMonth(periodMonth))}
              disabled={busy}
            >
              Next month
            </Button>
          </div>
        </div>
      </Card>

      {err ? (
        <Card className="p-4 border-destructive">
          <p className="text-sm text-destructive">{err}</p>
        </Card>
      ) : null}

      {loading ? (
        <Card className="p-6">
          <p className="text-sm text-muted-foreground">Loading...</p>
        </Card>
      ) : !isStarted ? (
        <Card className="p-6">
          <EmptyState
            title="No close started for this month"
            description="Kick off the checklist when you're ready to reconcile."
            actions={
              <Button onClick={startClose} disabled={busy}>
                Start monthly close
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          {/* Status + progress + close/reopen controls */}
          <Card className="p-4">
            <div className="flex flex-wrap items-center gap-3">
              <Badge variant={isClosed ? 'secondary' : 'outline'}>
                {isClosed ? 'Closed' : 'Open'}
              </Badge>
              <span className="text-sm text-muted-foreground">
                {completed}/{total} tasks complete
              </span>
              {isClosed && detail?.period?.closedAt ? (
                <span className="text-sm text-muted-foreground">
                  Closed on{' '}
                  {new Date(detail.period.closedAt).toLocaleDateString()}
                </span>
              ) : null}
              <div className="ml-auto flex gap-2">
                {isClosed ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={reopenMonth}
                    disabled={busy}
                  >
                    <Unlock size={16} aria-hidden="true" />
                    <span className="ml-2">Reopen</span>
                  </Button>
                ) : (
                  <>
                    {detail?.critical.hasCritical ? (
                      <Button
                        type="button"
                        variant="destructive"
                        onClick={() => closeMonth(true)}
                        disabled={busy}
                      >
                        Force-close with warnings
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      onClick={() => closeMonth(false)}
                      disabled={busy}
                    >
                      <Lock size={16} aria-hidden="true" />
                      <span className="ml-2">Close month</span>
                    </Button>
                  </>
                )}
              </div>
            </div>
          </Card>

          {/* Critical items panel */}
          {detail?.critical.hasCritical ? (
            <Card className="p-4 border-warning bg-warning-bg/30">
              <h3 className="text-sm font-semibold">Unresolved critical items</h3>
              <ul className="mt-2 list-disc pl-6 text-sm">
                {detail.critical.counts.unreviewedTransactions > 0 ? (
                  <li>
                    {detail.critical.counts.unreviewedTransactions} transaction
                    {detail.critical.counts.unreviewedTransactions === 1
                      ? ''
                      : 's'}{' '}
                    still flagged for review.{' '}
                    <Link
                      to="/review"
                      className="underline underline-offset-2"
                    >
                      Open review inbox
                    </Link>
                  </li>
                ) : null}
                {detail.critical.counts.outstandingPartnerBuckets > 0 ? (
                  <li>
                    {detail.critical.counts.outstandingPartnerBuckets} partner
                    settlement bucket
                    {detail.critical.counts.outstandingPartnerBuckets === 1
                      ? ''
                      : 's'}{' '}
                    with a non-zero balance.{' '}
                    <Link
                      to="/partner"
                      className="underline underline-offset-2"
                    >
                      Open partner balances
                    </Link>
                  </li>
                ) : null}
              </ul>
            </Card>
          ) : null}

          {/* Checklist */}
          <Card className="p-2">
            <ul className="divide-y">
              {detail?.tasks.map((task) => {
                const meta = TASK_META[task.taskKey]
                return (
                  <li
                    key={task.id}
                    className="flex flex-wrap items-center gap-3 p-3"
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      aria-label={
                        task.isComplete
                          ? `Mark ${meta?.title ?? task.taskKey} incomplete`
                          : `Mark ${meta?.title ?? task.taskKey} complete`
                      }
                      onClick={() => toggleTask(task.taskKey, !task.isComplete)}
                      disabled={busy || isClosed}
                      className="rounded-full p-1 disabled:opacity-50"
                    >
                      {task.isComplete ? (
                        <CheckCircle2
                          size={22}
                          className="text-positive"
                          aria-hidden="true"
                        />
                      ) : (
                        <Circle
                          size={22}
                          className="text-muted-foreground"
                          aria-hidden="true"
                        />
                      )}
                    </Button>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium">
                        {meta?.title ?? task.taskKey}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {meta?.description ?? null}
                      </div>
                    </div>
                    {meta?.deepLink ? (
                      <Link
                        to={meta.deepLink}
                        className="text-sm underline underline-offset-2"
                      >
                        Open
                      </Link>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          </Card>
        </>
      )}

      {/* History */}
      {history.length > 0 ? (
        <Card className="p-4">
          <h3 className="text-sm font-semibold mb-2">Past closes</h3>
          <ul className="space-y-2">
            {history.map((row) => (
              <li key={row.id} className="flex items-center gap-3 text-sm">
                <Button
                  type="button"
                  variant="ghost"
                  className="underline underline-offset-2"
                  onClick={() => setPeriodMonth(row.periodMonth)}
                >
                  {formatMonthLabel(row.periodMonth)}
                </Button>
                <Badge variant={row.status === 'closed' ? 'secondary' : 'outline'}>
                  {row.status}
                </Badge>
                {row.status === 'closed' && row.closedAt ? (
                  <span className="text-muted-foreground">
                    closed {new Date(row.closedAt).toLocaleDateString()}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  )
}
