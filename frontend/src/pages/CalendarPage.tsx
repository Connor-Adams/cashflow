/**
 * Financial calendar — month view + list view + 14-day summary.
 *
 * Data source: GET /api/calendar/events (read-only window over
 * planned_events with recurrences expanded server-side). Mutations
 * (create / edit / delete) reuse the planned-events API via an inline
 * dialog backed by the existing PlannedEventFormFields, so there's a
 * single source of truth for event validation and shape.
 *
 * Month-grid math lives in lib/calendarMonth.ts (unit-tested). This file
 * is presentational + state glue.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Calendar as CalendarIcon, CalendarPlus, ChevronLeft, ChevronRight, Edit3, Plus, Repeat, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  useConfirm,
} from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/ui/page-header'
import { Tabs } from '@/components/ui/tabs'
import { useToast } from '@/components/ui/toast'
import { deleteReq, getJson, postJson } from '../lib/api'
import { formatMoney } from '../lib/formatMoney'
import {
  buildMonthGrid,
  formatMonthHeading,
  monthGridRange,
  shiftMonth,
  todayYearMonth,
  upcomingRange,
} from '../lib/calendarMonth'
import { PlannedEventFormFields } from '@/components/planned-events/PlannedEventFormFields'
import {
  buildInput,
  emptyForm,
  type FormState,
} from '@/components/planned-events/plannedEventForm'
import {
  CALENDAR_EVENT_BG_CLASS,
  CALENDAR_EVENT_DOT_CLASS,
  type Account,
  type CalendarEvent,
  type CalendarEventsResponse,
  type PlannedEvent,
  type PlannedEventPatch,
  type PlannedEventType,
} from '../types/api'

type ViewMode = 'month' | 'list'

/**
 * Types that count as money flowing IN. Used for the 14-day summary
 * direction tally. Settlements net to zero across households so we don't
 * count them; transfers are intra-system; debt_payment + savings are
 * outflows from cash perspective.
 */
const INFLOW_TYPES = new Set<PlannedEventType>(['income'])
const OUTFLOW_TYPES = new Set<PlannedEventType>(['expense', 'debt_payment', 'savings'])

/** Map a CalendarEvent → +/-/0 signed amount for the summary cards. */
function signedAmount(event: CalendarEvent): number {
  const n = Number(event.amount)
  if (!Number.isFinite(n)) return 0
  if (INFLOW_TYPES.has(event.type)) return n
  if (OUTFLOW_TYPES.has(event.type)) return -n
  return 0
}

/**
 * Group events by their `eventDate`. Map insertion order matches the
 * upstream sort (eventDate ASC), so iteration order is stable.
 */
function groupByDate(events: CalendarEvent[]): Map<string, CalendarEvent[]> {
  const out = new Map<string, CalendarEvent[]>()
  for (const ev of events) {
    const list = out.get(ev.eventDate) ?? []
    list.push(ev)
    out.set(ev.eventDate, list)
  }
  return out
}

/**
 * Convenience PUT against /api/planned-events/:id. Mirrors the local
 * helper in PlannedEventsPage — kept inline rather than exported because
 * `lib/api.ts` does not expose a PUT helper and a one-call inline is
 * cheaper than expanding the shared surface.
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
    const raw = await res.text()
    let message = res.statusText
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

const TAB_ITEMS = [
  { value: 'month' as const, label: 'Month' },
  { value: 'list' as const, label: 'List' },
]

/**
 * Format a YYYY-MM-DD date string as e.g. "Tue, Jun 15".
 *
 * Parsing date-only strings via `new Date('YYYY-MM-DD')` interprets them
 * as UTC midnight, which can yesterday-shift in negative-UTC offsets.
 * Constructing via the three-arg form pins the local civil day, so the
 * label always matches what the user wrote into the date input.
 */
function formatDateLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map((p) => parseInt(p, 10))
  const date = new Date(y, m - 1, d)
  return date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}

export function CalendarPage() {
  const { showToast } = useToast()
  const confirm = useConfirm()
  const navigate = useNavigate()

  // Default month = today's local month, view = month grid.
  const initialYM = todayYearMonth()
  const [year, setYear] = useState(initialYM.year)
  const [month, setMonth] = useState(initialYM.month)
  const [view, setView] = useState<ViewMode>('month')

  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [upcoming, setUpcoming] = useState<CalendarEvent[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [dayDialogIso, setDayDialogIso] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [createDate, setCreateDate] = useState<string | null>(null)
  const [createForm, setCreateForm] = useState<FormState>(emptyForm())
  const [createSaving, setCreateSaving] = useState(false)

  const [editingId, setEditingId] = useState<number | null>(null)
  const [editForm, setEditForm] = useState<FormState>(emptyForm())
  const [editSaving, setEditSaving] = useState(false)

  const monthRange = useMemo(() => monthGridRange(year, month), [year, month])
  const upcoming14 = useMemo(() => upcomingRange(), [])

  const loadEvents = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({
        from: monthRange.from,
        to: monthRange.to,
      })
      const resp = await getJson<CalendarEventsResponse>(
        `/api/calendar/events?${params}`,
      )
      setEvents(resp.events)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load calendar')
      setEvents([])
    } finally {
      setLoading(false)
    }
  }, [monthRange.from, monthRange.to])

  const loadUpcoming = useCallback(async () => {
    try {
      const params = new URLSearchParams({
        from: upcoming14.from,
        to: upcoming14.to,
      })
      const resp = await getJson<CalendarEventsResponse>(
        `/api/calendar/events?${params}`,
      )
      setUpcoming(resp.events)
    } catch {
      setUpcoming([])
    }
  }, [upcoming14.from, upcoming14.to])

  useEffect(() => {
    void loadEvents()
  }, [loadEvents])

  useEffect(() => {
    void loadUpcoming()
  }, [loadUpcoming])

  useEffect(() => {
    void getJson<Account[]>('/api/accounts')
      .then((rows) => setAccounts(rows))
      .catch(() => setAccounts([]))
  }, [])

  const grid = useMemo(() => buildMonthGrid(year, month), [year, month])
  const eventsByDate = useMemo(() => groupByDate(events), [events])

  // Selected day's events for the day-detail dialog.
  const dayEvents = useMemo(() => {
    if (!dayDialogIso) return []
    return eventsByDate.get(dayDialogIso) ?? []
  }, [dayDialogIso, eventsByDate])

  /** Open create dialog seeded with the given (or today's) date. */
  function openCreate(dateIso?: string) {
    setCreateDate(dateIso ?? null)
    setCreateForm({
      ...emptyForm(),
      expectedDate: dateIso ?? '',
    })
    setCreateOpen(true)
  }

  function closeCreate() {
    setCreateOpen(false)
    setCreateDate(null)
    setCreateSaving(false)
  }

  async function saveCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const input = buildInput(createForm)
    if (!input) {
      showToast({
        title: 'Could not create event',
        description:
          'Fill in name, a non-negative amount, a 3-letter currency, and a YYYY-MM-DD date.',
        variant: 'destructive',
      })
      return
    }
    setCreateSaving(true)
    try {
      await postJson<PlannedEvent>('/api/planned-events', input)
      showToast({
        title: 'Event created',
        description: `${input.name} — ${formatMoney(input.amount, input.currency)} on ${input.expectedDate}`,
        variant: 'success',
      })
      closeCreate()
      await Promise.all([loadEvents(), loadUpcoming()])
    } catch (err) {
      showToast({
        title: 'Could not create event',
        description: err instanceof Error ? err.message : 'Server error',
        variant: 'destructive',
      })
      setCreateSaving(false)
    }
  }

  function openEdit(event: CalendarEvent) {
    setEditingId(event.id)
    setEditForm({
      type: event.type,
      name: event.name,
      amount: String(Number(event.amount)),
      currency: event.currency,
      expectedDate: event.anchorDate,
      accountId: event.accountId == null ? '' : String(event.accountId),
      recurrenceRule: event.recurrenceRule ?? '',
      status: event.status,
      notes: event.notes ?? '',
    })
  }

  function cancelEdit() {
    setEditingId(null)
    setEditForm(emptyForm())
    setEditSaving(false)
  }

  async function saveEdit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (editingId == null) return
    const input = buildInput(editForm)
    if (!input) {
      showToast({
        title: 'Could not save event',
        description: 'Fill required fields with valid values.',
        variant: 'destructive',
      })
      return
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { source: _ignored, ...patch } = input
    setEditSaving(true)
    try {
      await putPlannedEvent(editingId, patch)
      showToast({ title: 'Event updated', variant: 'success' })
      cancelEdit()
      setDayDialogIso(null)
      await Promise.all([loadEvents(), loadUpcoming()])
    } catch (err) {
      showToast({
        title: 'Could not save event',
        description: err instanceof Error ? err.message : 'Server error',
        variant: 'destructive',
      })
      setEditSaving(false)
    }
  }

  async function deleteEvent(event: CalendarEvent) {
    const ok = await confirm({
      title: 'Delete this event?',
      description: `${event.name} on ${event.eventDate}${
        event.recurrenceRule
          ? ' — this is a recurring rule; the entire series will be removed.'
          : '.'
      }`,
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    try {
      await deleteReq(`/api/planned-events/${event.id}`)
      showToast({ title: 'Event removed', variant: 'success' })
      setDayDialogIso(null)
      cancelEdit()
      await Promise.all([loadEvents(), loadUpcoming()])
    } catch (err) {
      showToast({
        title: 'Could not delete event',
        description: err instanceof Error ? err.message : 'Server error',
        variant: 'destructive',
      })
    }
  }

  function goPrev() {
    const next = shiftMonth(year, month, -1)
    setYear(next.year)
    setMonth(next.month)
  }
  function goNext() {
    const next = shiftMonth(year, month, 1)
    setYear(next.year)
    setMonth(next.month)
  }
  function goToday() {
    const ym = todayYearMonth()
    setYear(ym.year)
    setMonth(ym.month)
  }

  // Aggregate upcoming-14-day totals by type for the summary card.
  const summary = useMemo(() => {
    let inflow = 0
    let outflow = 0
    const byType = new Map<PlannedEventType, number>()
    for (const ev of upcoming) {
      const signed = signedAmount(ev)
      if (signed > 0) inflow += signed
      else if (signed < 0) outflow += -signed
      byType.set(ev.type, (byType.get(ev.type) ?? 0) + Number(ev.amount))
    }
    return { inflow, outflow, net: inflow - outflow, count: upcoming.length, byType }
  }, [upcoming])

  const dialogTitleDate = dayDialogIso
    ? formatDateLabel(dayDialogIso)
    : ''

  return (
    <>
      <PageHeader
        title="Financial calendar"
        description="Upcoming income, expenses, transfers, and goal contributions. All events come from your planned events list."
      />

      <div className="row" style={{ flexWrap: 'wrap', gap: '0.75rem', marginBottom: '1rem' }}>
        <Tabs items={TAB_ITEMS} value={view} onValueChange={(v) => setView(v as ViewMode)} />
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <Button variant="outline" size="sm" onClick={goPrev} aria-label="Previous month">
            <ChevronLeft aria-hidden="true" />
          </Button>
          <span className="font-medium" style={{ minWidth: '8rem', textAlign: 'center' }}>
            {formatMonthHeading(year, month)}
          </span>
          <Button variant="outline" size="sm" onClick={goNext} aria-label="Next month">
            <ChevronRight aria-hidden="true" />
          </Button>
          <Button variant="outline" size="sm" onClick={goToday}>
            Today
          </Button>
          <Button size="sm" onClick={() => openCreate()}>
            <Plus aria-hidden="true" /> New event
          </Button>
          <Link
            to="/planned"
            className="text-sm underline"
            style={{ marginLeft: '0.5rem' }}
          >
            Manage events
          </Link>
        </div>
      </div>

      <UpcomingSummaryCard summary={summary} />

      {error ? (
        <div role="alert" className="muted" style={{ padding: '1rem' }}>
          Failed to load calendar: {error}
        </div>
      ) : null}

      {view === 'month' ? (
        <MonthGridView
          grid={grid}
          eventsByDate={eventsByDate}
          loading={loading}
          month={month}
          onDayClick={(iso) => setDayDialogIso(iso)}
        />
      ) : (
        <ListView
          events={events}
          loading={loading}
          onEditClick={(ev) => {
            setDayDialogIso(null)
            openEdit(ev)
          }}
          onDeleteClick={(ev) => void deleteEvent(ev)}
        />
      )}

      {/* Day-detail dialog: lists events for the clicked day, with
          Edit/Delete affordances per row. */}
      {dayDialogIso ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setDayDialogIso(null)
          }}
        >
          <DialogHeader>
            <DialogTitle>{dialogTitleDate}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            {dayEvents.length === 0 ? (
              <EmptyState
                title="No events on this day."
                description="Add one below."
              />
            ) : (
              <ul style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {dayEvents.map((ev) => (
                  <li
                    key={`${ev.id}-${ev.eventDate}`}
                    className="row"
                    style={{
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '0.75rem',
                      borderBottom: '1px solid var(--border)',
                      paddingBottom: '0.5rem',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <span
                        className={`inline-block h-3 w-3 rounded-full ${CALENDAR_EVENT_DOT_CLASS[ev.type]}`}
                        aria-hidden="true"
                      />
                      <div>
                        <div className="font-medium">{ev.name}</div>
                        <div className="muted text-xs">
                          {ev.kindLabel} ·{' '}
                          {formatMoney(Number(ev.amount), ev.currency)}
                          {ev.recurrenceRule ? ' · recurring' : ''}
                        </div>
                      </div>
                    </div>
                    <div className="row" style={{ gap: '0.25rem' }}>
                      <Badge className={CALENDAR_EVENT_BG_CLASS[ev.type]}>
                        {ev.recurrenceRule ? (
                          <Repeat
                            aria-hidden="true"
                            className="mr-1 inline-block h-3 w-3"
                          />
                        ) : (
                          <CalendarPlus
                            aria-hidden="true"
                            className="mr-1 inline-block h-3 w-3"
                          />
                        )}
                        {ev.kindLabel}
                      </Badge>
                      <Link
                        to={ev.recurrenceRule ? '/recurring' : '/planned'}
                        className="text-xs underline text-muted-foreground"
                        onClick={() => setDayDialogIso(null)}
                      >
                        View source
                      </Link>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setDayDialogIso(null)
                          openEdit(ev)
                        }}
                      >
                        <Edit3 aria-hidden="true" /> Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => void deleteEvent(ev)}
                      >
                        <Trash2 aria-hidden="true" /> Delete
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </DialogBody>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDayDialogIso(null)}
            >
              Close
            </Button>
            <Button
              onClick={() => {
                const iso = dayDialogIso
                setDayDialogIso(null)
                openCreate(iso ?? undefined)
              }}
            >
              <Plus aria-hidden="true" /> Add event on this day
            </Button>
          </DialogFooter>
        </Dialog>
      ) : null}

      {/* Create dialog */}
      {createOpen ? (
        <Dialog open onOpenChange={(open) => { if (!open) closeCreate() }}>
          <DialogHeader>
            <DialogTitle>
              {createDate
                ? `New event on ${formatDateLabel(createDate)}`
                : 'New planned event'}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={saveCreate}>
            <DialogBody>
              <PlannedEventFormFields
                form={createForm}
                setForm={setCreateForm}
                accountOptions={accounts.filter((a) => a.closedAt == null)}
                idPrefix="calendar-create"
                showStatus={false}
              />
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={closeCreate} disabled={createSaving}>
                Cancel
              </Button>
              <Button type="submit" disabled={createSaving}>
                <Plus aria-hidden="true" />
                {createSaving ? 'Saving...' : 'Save event'}
              </Button>
            </DialogFooter>
          </form>
        </Dialog>
      ) : null}

      {/* Edit dialog */}
      {editingId != null ? (
        <Dialog open onOpenChange={(open) => { if (!open) cancelEdit() }}>
          <DialogHeader>
            <DialogTitle>Edit planned event</DialogTitle>
          </DialogHeader>
          <form onSubmit={saveEdit}>
            <DialogBody>
              <PlannedEventFormFields
                form={editForm}
                setForm={setEditForm}
                accountOptions={accounts.filter((a) => a.closedAt == null)}
                idPrefix={`calendar-edit-${editingId}`}
                showStatus
              />
              <p className="muted text-xs" style={{ marginTop: '0.75rem' }}>
                Need to link this event to a transaction?{' '}
                <Button
                  type="button"
                  variant="link"
                  className="underline"
                  onClick={() => {
                    cancelEdit()
                    navigate('/planned')
                  }}
                >
                  Open the full editor
                </Button>
                .
              </p>
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={cancelEdit} disabled={editSaving}>
                Cancel
              </Button>
              <Button type="submit" disabled={editSaving}>
                {editSaving ? 'Saving...' : 'Save changes'}
              </Button>
            </DialogFooter>
          </form>
        </Dialog>
      ) : null}

      {confirm.dialog}
    </>
  )
}

// ---- Subviews -------------------------------------------------------------

type UpcomingSummary = {
  inflow: number
  outflow: number
  net: number
  count: number
  byType: Map<PlannedEventType, number>
}

function UpcomingSummaryCard({ summary }: { summary: UpcomingSummary }) {
  return (
    <Card className="accountsFormCard" style={{ marginBottom: '1rem' }}>
      <div className="accountsCardHeader">
        <div>
          <h2 className="flex items-center gap-2">
            <CalendarIcon aria-hidden="true" className="h-5 w-5" />
            Next 14 days
          </h2>
          <p className="muted">
            {summary.count === 0
              ? 'Nothing planned in the next two weeks.'
              : `${summary.count} event${summary.count === 1 ? '' : 's'} ahead.`}
          </p>
        </div>
        <div className="row" style={{ gap: '1.25rem', flexWrap: 'wrap' }}>
          <Stat label="Expected in" value={summary.inflow} positive />
          <Stat label="Expected out" value={summary.outflow} negative />
          <Stat
            label="Net"
            value={summary.net}
            positive={summary.net >= 0}
            negative={summary.net < 0}
          />
        </div>
      </div>
    </Card>
  )
}

function Stat({
  label,
  value,
  positive,
  negative,
}: {
  label: string
  value: number
  positive?: boolean
  negative?: boolean
}) {
  const color = positive
    ? 'text-emerald-600 dark:text-emerald-300'
    : negative
      ? 'text-rose-600 dark:text-rose-300'
      : 'text-zinc-700 dark:text-zinc-200'
  return (
    <div>
      <div className="muted text-xs">{label}</div>
      <div className={`text-lg font-semibold ${color}`}>
        {formatMoney(value, 'CAD')}
      </div>
    </div>
  )
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

type MonthGridViewProps = {
  grid: ReturnType<typeof buildMonthGrid>
  eventsByDate: Map<string, CalendarEvent[]>
  loading: boolean
  month: number
  onDayClick: (iso: string) => void
}

function MonthGridView({ grid, eventsByDate, loading, month, onDayClick }: MonthGridViewProps) {
  const navigate = useNavigate()
  return (
    <Card className="accountsFormCard">
      <div
        role="grid"
        aria-label="Month calendar"
        style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '1px', background: 'var(--border)' }}
      >
        {WEEKDAYS.map((d) => (
          <div
            key={d}
            role="columnheader"
            className="muted text-xs"
            style={{ padding: '0.4rem', background: 'var(--card)', textAlign: 'center', fontWeight: 600 }}
          >
            {d}
          </div>
        ))}
        {grid.map((cell) => {
          const events = eventsByDate.get(cell.iso) ?? []
          const visible = events.slice(0, 3)
          const hidden = events.length - visible.length
          return (
            <Button
              key={cell.iso}
              type="button"
              variant="ghost"
              role="gridcell"
              onClick={() => onDayClick(cell.iso)}
              aria-label={`${cell.iso}, ${events.length} event${events.length === 1 ? '' : 's'}`}
              data-in-month={cell.inMonth}
              data-today={cell.isToday}
              style={{
                background: 'var(--card)',
                opacity: cell.inMonth ? 1 : 0.45,
                minHeight: '5.5rem',
                padding: '0.4rem',
                textAlign: 'left',
                border: 0,
                cursor: 'pointer',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.25rem',
                outline: cell.isToday ? '2px solid var(--primary, currentColor)' : 'none',
                outlineOffset: '-2px',
              }}
            >
              <span className="text-xs font-medium">{cell.day}</span>
              {visible.map((ev, i) => (
                <span
                  key={`${ev.id}-${i}`}
                  role="link"
                  tabIndex={0}
                  className={`text-xs truncate rounded px-1 cursor-pointer hover:opacity-80 ${CALENDAR_EVENT_BG_CLASS[ev.type]}`}
                  title={ev.recurrenceRule ? 'Recurring charge' : 'Planned event'}
                  onClick={(e) => { e.stopPropagation(); navigate(ev.recurrenceRule ? '/recurring' : '/planned') }}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); navigate(ev.recurrenceRule ? '/recurring' : '/planned') } }}
                >
                  {ev.recurrenceRule ? (
                    <Repeat aria-hidden="true" className="mr-0.5 inline-block h-2.5 w-2.5" />
                  ) : (
                    <CalendarPlus aria-hidden="true" className="mr-0.5 inline-block h-2.5 w-2.5" />
                  )}
                  {ev.name}
                </span>
              ))}
              {hidden > 0 ? (
                <span className="muted text-xs">+{hidden} more</span>
              ) : null}
            </Button>
          )
        })}
      </div>
      {loading ? (
        <p className="muted" style={{ marginTop: '0.5rem' }}>Loading…</p>
      ) : null}
      {/* `month` prop is consumed via grid construction upstream; we accept
          it here so the parent can re-render the grid when it changes. */}
      <span hidden>{month}</span>
    </Card>
  )
}

type ListViewProps = {
  events: CalendarEvent[]
  loading: boolean
  onEditClick: (ev: CalendarEvent) => void
  onDeleteClick: (ev: CalendarEvent) => void
}

function ListView({ events, loading, onEditClick, onDeleteClick }: ListViewProps) {
  const grouped = useMemo(() => groupByDate(events), [events])
  const entries = Array.from(grouped.entries())
  return (
    <Card className="accountsFormCard">
      {loading ? <p className="muted">Loading…</p> : null}
      {entries.length === 0 && !loading ? (
        <EmptyState
          title="No events in this window."
          description="Try a different month or add a planned event."
        />
      ) : null}
      {entries.map(([iso, evs]) => (
        <section
          key={iso}
          style={{
            borderBottom: '1px solid var(--border)',
            paddingBottom: '0.75rem',
            marginBottom: '0.75rem',
          }}
        >
          <h3 className="text-sm font-semibold" style={{ marginBottom: '0.4rem' }}>
            {formatDateLabel(iso)}
          </h3>
          <ul style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {evs.map((ev) => (
              <li
                key={`${ev.id}-${ev.eventDate}`}
                className="row"
                style={{
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: '0.75rem',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span
                    className={`inline-block h-3 w-3 rounded-full ${CALENDAR_EVENT_DOT_CLASS[ev.type]}`}
                    aria-hidden="true"
                  />
                  <div>
                    <div className="font-medium">{ev.name}</div>
                    <div className="muted text-xs">
                      {ev.kindLabel} ·{' '}
                      {formatMoney(Number(ev.amount), ev.currency)}
                      {ev.recurrenceRule ? ' · recurring' : ''}
                    </div>
                  </div>
                </div>
                <div className="row" style={{ gap: '0.25rem' }}>
                  <Badge className={CALENDAR_EVENT_BG_CLASS[ev.type]}>
                    {ev.recurrenceRule ? (
                      <Repeat
                        aria-hidden="true"
                        className="mr-1 inline-block h-3 w-3"
                      />
                    ) : (
                      <CalendarPlus
                        aria-hidden="true"
                        className="mr-1 inline-block h-3 w-3"
                      />
                    )}
                    {ev.kindLabel}
                  </Badge>
                  <Link
                    to={ev.recurrenceRule ? '/recurring' : '/planned'}
                    className="text-xs underline text-muted-foreground"
                  >
                    View source
                  </Link>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => onEditClick(ev)}
                  >
                    <Edit3 aria-hidden="true" /> Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => onDeleteClick(ev)}
                  >
                    <Trash2 aria-hidden="true" /> Delete
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </Card>
  )
}
