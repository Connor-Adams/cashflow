import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Edit3 } from 'lucide-react'
import { Badge, Icon } from '@connor-adams/designsystem'
import { Button } from '@connor-adams/designsystem'
import { Card } from '@connor-adams/designsystem'
import { useConfirm } from '@/lib/ds-extras'
import { EmptyState } from '@connor-adams/designsystem'
import { Label } from '@connor-adams/designsystem'
import { NativeSelect } from '@connor-adams/designsystem'
import { PageHeader } from '@/components/ui/page-header'
import { SectionHeader } from '@/components/ui/section-header'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@connor-adams/designsystem'
import { useToast } from '@/components/ui/toast'
import { PlannedEventFormFields } from '@/components/planned-events/PlannedEventFormFields'
import {
  PLANNED_EVENT_STATUS_OPTIONS,
  STATUS_BADGE,
  TYPE_TONE,
  TYPE_TONE_CLASS,
  buildInput,
  buildPatch,
  emptyForm,
  rowToForm,
  statusLabel,
  typeLabel,
  type FormState,
} from '@/components/planned-events/plannedEventForm'
import { deleteReq, getJson, postJson } from '../lib/api'
import { formatMoney } from '../lib/formatMoney'
import type {
  Account,
  PlannedEvent,
  PlannedEventPatch,
  PlannedEventsResponse,
  PlannedEventStatus,
} from '../types/api'

/**
 * Wrapper for `fetch` PUT against /api/planned-events/:id. The shared
 * `lib/api.ts` helper set exposes POST/PATCH/DELETE but not PUT, so we
 * inline a tiny client here. Mirrors the credential and error-handling
 * contract of the shared helpers.
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

export function PlannedEventsPage() {
  const { showToast } = useToast()
  const confirm = useConfirm()

  const [events, setEvents] = useState<PlannedEvent[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [form, setForm] = useState<FormState>(emptyForm())
  const [submitting, setSubmitting] = useState(false)
  const [editId, setEditId] = useState<number | null>(null)
  const [editForm, setEditForm] = useState<FormState>(emptyForm())
  const [editSaving, setEditSaving] = useState(false)
  const [statusFilter, setStatusFilter] = useState<PlannedEventStatus | ''>('')

  // Deep-link focus: /planned?focus=<id> (e.g. from the forecast shortfall
  // drilldown) scrolls the matching row into view and applies a ring
  // highlight that fades via CSS animation. Unknown ids are a silent no-op.
  const [searchParams] = useSearchParams()
  const focusParam = searchParams.get('focus')
  const focusId = focusParam != null ? Number(focusParam) : null
  const focusRowRef = useRef<HTMLTableRowElement | null>(null)

  const loadEvents = useCallback(async () => {
    try {
      const path = statusFilter
        ? `/api/planned-events?status=${encodeURIComponent(statusFilter)}`
        : '/api/planned-events'
      const resp = await getJson<PlannedEventsResponse>(path)
      setEvents(resp.data)
    } catch {
      // Surfaced via toast in handlers
    }
  }, [statusFilter])

  useEffect(() => {
    void loadEvents()
  }, [loadEvents])

  useEffect(() => {
    void getJson<Account[]>('/api/accounts')
      .then((rows) => setAccounts(rows))
      .catch(() => setAccounts([]))
  }, [])

  // The id (if any) of the loaded row to highlight. Persistent class — the
  // CSS animation (.plannedRow.isFocused) handles the visual fade, so there
  // is no JS timer to race component tests.
  const highlightId =
    focusId != null && !Number.isNaN(focusId) && events.some((e) => e.id === focusId)
      ? focusId
      : null

  // Scroll the focused row into view once it is in the DOM.
  useEffect(() => {
    if (highlightId == null) return
    // scrollIntoView is undefined in jsdom; guard so tests don't throw.
    focusRowRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
  }, [highlightId, events])

  const accountOptions = useMemo(() => {
    return accounts
      .filter((a) => a.closedAt == null)
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [accounts])

  const accountNamesById = useMemo(() => {
    const m = new Map<number, string>()
    for (const a of accounts) m.set(a.id, a.name)
    return m
  }, [accounts])

  async function createEvent(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const input = buildInput(form)
    if (!input) {
      showToast({
        title: 'Could not add planned event',
        description:
          'Fill in name, a non-negative amount, a 3-letter currency, and a YYYY-MM-DD date.',
        variant: 'destructive',
      })
      return
    }
    setSubmitting(true)
    try {
      await postJson<PlannedEvent>('/api/planned-events', input)
      setForm(emptyForm(form.currency))
      await loadEvents()
      showToast({
        title: `Added ${typeLabel(input.type).toLowerCase()}`,
        description: `${input.name} — ${formatMoney(input.amount, input.currency)} on ${input.expectedDate}`,
        variant: 'success',
      })
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Could not add planned event'
      showToast({
        title: 'Could not add planned event',
        description: message,
        variant: 'destructive',
      })
    } finally {
      setSubmitting(false)
    }
  }

  function openEdit(row: PlannedEvent) {
    setEditId(row.id)
    setEditForm(rowToForm(row))
  }

  function cancelEdit() {
    setEditId(null)
    setEditForm(emptyForm())
    setEditSaving(false)
  }

  async function saveEdit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (editId == null) return
    const patch = buildPatch(editForm)
    if (!patch) {
      showToast({
        title: 'Could not save planned event',
        description:
          'Fill in name, a non-negative amount, a 3-letter currency, and a YYYY-MM-DD date.',
        variant: 'destructive',
      })
      return
    }
    setEditSaving(true)
    try {
      await putPlannedEvent(editId, patch)
      cancelEdit()
      await loadEvents()
      showToast({ title: 'Planned event updated', variant: 'success' })
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Could not save planned event'
      showToast({
        title: 'Could not save planned event',
        description: message,
        variant: 'destructive',
      })
      setEditSaving(false)
    }
  }

  async function deleteEvent(row: PlannedEvent) {
    const ok = await confirm({
      title: 'Delete planned event?',
      description: `${row.name} (${row.expectedDate}) will be removed.`,
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    try {
      await deleteReq(`/api/planned-events/${row.id}`)
      await loadEvents()
      showToast({ title: 'Planned event removed', variant: 'success' })
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Could not delete planned event'
      showToast({
        title: 'Could not delete planned event',
        description: message,
        variant: 'destructive',
      })
    }
  }

  return (
    <>
      <PageHeader
        title="Planned events"
        description="Future income, expenses, transfers, and goal contributions. Powers forecast, calendar, and safe-to-spend."
      />
      <Card>
        <SectionHeader
          title={
            <span className="flex items-center gap-2">
              <Icon name="calendar" aria-hidden="true" className="h-5 w-5" />
              Upcoming
            </span>
          }
          description={
            events.length === 0
              ? 'Add a planned event below to start projecting your cashflow.'
              : `${events.length} event${events.length === 1 ? '' : 's'} on file.`
          }
          actions={
            <Label htmlFor="planned-events-status-filter" className="text-sm">
              Status
              <NativeSelect
                id="planned-events-status-filter"
                value={statusFilter}
                onChange={(e) =>
                  setStatusFilter(e.target.value as PlannedEventStatus | '')
                }
              >
                <option value="">All</option>
                {PLANNED_EVENT_STATUS_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </NativeSelect>
            </Label>
          }
        />
        {events.length === 0 ? (
          <EmptyState
            title="No planned events yet."
            description="Add a future income or expense to start your forecast."
          />
        ) : (
          <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead>Recurrence</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead aria-label="Actions" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {events.map((row) => {
                  if (editId === row.id) {
                    return (
                      <TableRow key={row.id}>
                        <TableCell colSpan={8}>
                          <form onSubmit={saveEdit}>
                            <PlannedEventFormFields
                              form={editForm}
                              setForm={setEditForm}
                              accountOptions={accountOptions}
                              idPrefix={`planned-event-edit-${row.id}`}
                              showStatus
                            />
                            <div className="mb-3 flex flex-wrap items-center gap-3">
                              <Button
                                type="submit"
                                size="sm"
                                disabled={editSaving}
                              >
                                Save
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={cancelEdit}
                                disabled={editSaving}
                              >
                                Cancel
                              </Button>
                            </div>
                          </form>
                        </TableCell>
                      </TableRow>
                    )
                  }
                  const tone = TYPE_TONE[row.type]
                  const isFocused = highlightId === row.id
                  return (
                    <tr
                      key={row.id}
                      ref={isFocused ? focusRowRef : undefined}
                      className={
                        isFocused
                          ? 'border-b border-border transition-colors hover:bg-muted/45 plannedRow isFocused ring-2 ring-warning'
                          : 'border-b border-border transition-colors hover:bg-muted/45'
                      }
                    >
                      <TableCell>{row.expectedDate}</TableCell>
                      <TableCell>
                        <div className="font-medium">{row.name}</div>
                        {row.notes ? (
                          <div className="text-xs text-muted-foreground">
                            {row.notes}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <span className={TYPE_TONE_CLASS[tone]}>
                          {typeLabel(row.type)}
                        </span>
                      </TableCell>
                      <TableCell>
                        {formatMoney(Number(row.amount), row.currency)}
                      </TableCell>
                      <TableCell>
                        {row.accountId == null
                          ? '—'
                          : accountNamesById.get(row.accountId) ??
                            `#${row.accountId}`}
                      </TableCell>
                      <TableCell>
                        {row.recurrenceRule ? (
                          <span className="font-mono text-xs">
                            {row.recurrenceRule}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            One-off
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge className={STATUS_BADGE[row.status]}>
                          {statusLabel(row.status)}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="mb-3 flex flex-wrap items-center gap-3">
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            onClick={() => openEdit(row)}
                          >
                            <Edit3 aria-hidden="true" />
                            Edit
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="destructive"
                            onClick={() => void deleteEvent(row)}
                          >
                            <Icon name="trash" aria-hidden="true" />
                            Delete
                          </Button>
                          <Link to={`/forecast?date=${row.expectedDate}`}>
                            <Button size="sm" variant="ghost">
                              Forecast →
                            </Button>
                          </Link>
                        </div>
                      </TableCell>
                    </tr>
                  )
                })}
              </TableBody>
            </Table>
        )}

        <form onSubmit={createEvent}>
          <h3 className="mt-4">Add planned event</h3>
          <PlannedEventFormFields
            form={form}
            setForm={setForm}
            accountOptions={accountOptions}
            idPrefix="planned-event-new"
            showStatus={false}
          />
          <Button type="submit" disabled={submitting}>
            <Icon name="plus" aria-hidden="true" />
            Add planned event
          </Button>
        </form>
      </Card>
      {confirm.dialog}
    </>
  )
}
