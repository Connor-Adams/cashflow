import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { Calendar, Edit3, Plus, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { useConfirm } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import { PageHeader } from '@/components/ui/page-header'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/components/ui/toast'
import { deleteReq, getJson, postJson } from '../lib/api'
import { formatMoney } from '../lib/formatMoney'
import type {
  Account,
  PlannedEvent,
  PlannedEventInput,
  PlannedEventPatch,
  PlannedEventsResponse,
  PlannedEventSource,
  PlannedEventStatus,
  PlannedEventType,
} from '../types/api'

const DEFAULT_CURRENCY = 'CAD'

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

const PLANNED_EVENT_TYPE_OPTIONS: Array<{ value: PlannedEventType; label: string }> = [
  { value: 'income', label: 'Income' },
  { value: 'expense', label: 'Expense' },
  { value: 'transfer', label: 'Transfer' },
  { value: 'settlement', label: 'Settlement' },
  { value: 'debt_payment', label: 'Debt payment' },
  { value: 'savings', label: 'Savings' },
]

const PLANNED_EVENT_STATUS_OPTIONS: Array<{ value: PlannedEventStatus; label: string }> = [
  { value: 'planned', label: 'Planned' },
  { value: 'posted', label: 'Posted' },
  { value: 'skipped', label: 'Skipped' },
  { value: 'ignored', label: 'Ignored' },
]

// Tailwind v4 JIT needs literal class names — Sidebar/Theme docs note this.
// Look up colour classes per status/type via tables instead of building
// strings dynamically so the bundler keeps them.
const STATUS_BADGE: Record<PlannedEventStatus, string> = {
  planned: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-100',
  posted: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-100',
  skipped: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-100',
  ignored: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-100',
}

const TYPE_TONE: Record<PlannedEventType, 'inflow' | 'outflow' | 'neutral'> = {
  income: 'inflow',
  expense: 'outflow',
  transfer: 'neutral',
  settlement: 'neutral',
  debt_payment: 'outflow',
  savings: 'outflow',
}

const TYPE_TONE_CLASS: Record<'inflow' | 'outflow' | 'neutral', string> = {
  inflow: 'text-emerald-600 dark:text-emerald-300',
  outflow: 'text-rose-600 dark:text-rose-300',
  neutral: 'text-zinc-600 dark:text-zinc-300',
}

function typeLabel(type: PlannedEventType): string {
  return (
    PLANNED_EVENT_TYPE_OPTIONS.find((o) => o.value === type)?.label ?? type
  )
}

function statusLabel(status: PlannedEventStatus): string {
  return (
    PLANNED_EVENT_STATUS_OPTIONS.find((o) => o.value === status)?.label ??
    status
  )
}

type FormState = {
  type: PlannedEventType
  name: string
  amount: string
  currency: string
  expectedDate: string
  accountId: string
  recurrenceRule: string
  status: PlannedEventStatus
  notes: string
}

function emptyForm(currency: string = DEFAULT_CURRENCY): FormState {
  return {
    type: 'expense',
    name: '',
    amount: '',
    currency,
    expectedDate: '',
    accountId: '',
    recurrenceRule: '',
    status: 'planned',
    notes: '',
  }
}

function rowToForm(row: PlannedEvent): FormState {
  return {
    type: row.type,
    name: row.name,
    amount: String(Number(row.amount)),
    currency: row.currency,
    expectedDate: row.expectedDate,
    accountId: row.accountId == null ? '' : String(row.accountId),
    recurrenceRule: row.recurrenceRule ?? '',
    status: row.status,
    notes: row.notes ?? '',
  }
}

function buildInput(
  form: FormState,
  source: PlannedEventSource = 'manual',
): PlannedEventInput | null {
  const name = form.name.trim()
  if (!name) return null
  const amount = Number(form.amount)
  if (!Number.isFinite(amount) || amount < 0) return null
  const currency = form.currency.trim().toUpperCase()
  if (currency.length !== 3) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.expectedDate)) return null
  const accountId =
    form.accountId === '' ? null : Number.parseInt(form.accountId, 10)
  if (accountId != null && !Number.isInteger(accountId)) return null
  const recurrence = form.recurrenceRule.trim()
  const notes = form.notes.trim()
  return {
    type: form.type,
    name,
    amount,
    currency,
    expectedDate: form.expectedDate,
    accountId,
    recurrenceRule: recurrence ? recurrence : null,
    status: form.status,
    source,
    notes: notes ? notes : null,
  }
}

function buildPatch(form: FormState): PlannedEventPatch | null {
  const input = buildInput(form)
  if (!input) return null
  // For edit we don't change `source` (the originating subsystem owns it).
  // Drop it from the patch so editing a system-managed row does not
  // accidentally promote it to manual.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { source: _ignored, ...rest } = input
  return rest
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
      <Card className="accountsFormCard">
        <div className="accountsCardHeader">
          <div>
            <h2 className="flex items-center gap-2">
              <Calendar aria-hidden="true" className="h-5 w-5" />
              Upcoming
            </h2>
            <p className="muted">
              {events.length === 0
                ? 'Add a planned event below to start projecting your cashflow.'
                : `${events.length} event${events.length === 1 ? '' : 's'} on file.`}
            </p>
          </div>
          <div>
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
          </div>
        </div>
        {events.length === 0 ? (
          <EmptyState
            title="No planned events yet."
            description="Add a future income or expense to start your forecast."
          />
        ) : (
          <div className="tableWrap">
            <Table className="table">
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
                            <div className="row">
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
                  return (
                    <TableRow key={row.id}>
                      <TableCell>{row.expectedDate}</TableCell>
                      <TableCell>
                        <div className="font-medium">{row.name}</div>
                        {row.notes ? (
                          <div className="muted text-xs">{row.notes}</div>
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
                          <span className="muted text-xs">One-off</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge className={STATUS_BADGE[row.status]}>
                          {statusLabel(row.status)}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="row">
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
                            <Trash2 aria-hidden="true" />
                            Delete
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
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
            <Plus aria-hidden="true" />
            Add planned event
          </Button>
        </form>
      </Card>
      {confirm.dialog}
    </>
  )
}

type PlannedEventFormFieldsProps = {
  form: FormState
  setForm: (updater: (prev: FormState) => FormState) => void
  accountOptions: Account[]
  idPrefix: string
  showStatus: boolean
}

function PlannedEventFormFields({
  form,
  setForm,
  accountOptions,
  idPrefix,
  showStatus,
}: PlannedEventFormFieldsProps) {
  return (
    <div className="formGrid">
      <Label htmlFor={`${idPrefix}-type`}>
        Type
        <NativeSelect
          id={`${idPrefix}-type`}
          value={form.type}
          onChange={(e) =>
            setForm((prev) => ({
              ...prev,
              type: e.target.value as PlannedEventType,
            }))
          }
        >
          {PLANNED_EVENT_TYPE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </NativeSelect>
      </Label>
      <Label htmlFor={`${idPrefix}-name`}>
        Name
        <Input
          id={`${idPrefix}-name`}
          value={form.name}
          onChange={(e) =>
            setForm((prev) => ({ ...prev, name: e.target.value }))
          }
          required
          maxLength={255}
          placeholder="Rent, Paycheck, Gym membership…"
        />
      </Label>
      <Label htmlFor={`${idPrefix}-amount`}>
        Amount
        <Input
          id={`${idPrefix}-amount`}
          type="number"
          step="0.01"
          min="0"
          value={form.amount}
          onChange={(e) =>
            setForm((prev) => ({ ...prev, amount: e.target.value }))
          }
          required
          placeholder="0.00"
        />
      </Label>
      <Label htmlFor={`${idPrefix}-currency`}>
        Currency
        <Input
          id={`${idPrefix}-currency`}
          value={form.currency}
          onChange={(e) =>
            setForm((prev) => ({
              ...prev,
              currency: e.target.value.toUpperCase().slice(0, 3),
            }))
          }
          required
          maxLength={3}
          autoComplete="off"
        />
      </Label>
      <Label htmlFor={`${idPrefix}-date`}>
        Expected date
        <Input
          id={`${idPrefix}-date`}
          type="date"
          value={form.expectedDate}
          onChange={(e) =>
            setForm((prev) => ({ ...prev, expectedDate: e.target.value }))
          }
          required
        />
      </Label>
      <Label htmlFor={`${idPrefix}-account`}>
        Account (optional)
        <NativeSelect
          id={`${idPrefix}-account`}
          value={form.accountId}
          onChange={(e) =>
            setForm((prev) => ({ ...prev, accountId: e.target.value }))
          }
        >
          <option value="">Unassigned</option>
          {accountOptions.map((a) => (
            <option key={a.id} value={String(a.id)}>
              {a.name}
              {a.defaultCurrency ? ` (${a.defaultCurrency})` : ''}
            </option>
          ))}
        </NativeSelect>
      </Label>
      <Label htmlFor={`${idPrefix}-recurrence`}>
        Recurrence rule (optional)
        <Input
          id={`${idPrefix}-recurrence`}
          value={form.recurrenceRule}
          onChange={(e) =>
            setForm((prev) => ({ ...prev, recurrenceRule: e.target.value }))
          }
          placeholder="FREQ=MONTHLY;BYMONTHDAY=1"
        />
      </Label>
      {showStatus ? (
        <Label htmlFor={`${idPrefix}-status`}>
          Status
          <NativeSelect
            id={`${idPrefix}-status`}
            value={form.status}
            onChange={(e) =>
              setForm((prev) => ({
                ...prev,
                status: e.target.value as PlannedEventStatus,
              }))
            }
          >
            {PLANNED_EVENT_STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </NativeSelect>
        </Label>
      ) : null}
      <Label htmlFor={`${idPrefix}-notes`}>
        Notes
        <Textarea
          id={`${idPrefix}-notes`}
          value={form.notes}
          onChange={(e) =>
            setForm((prev) => ({ ...prev, notes: e.target.value }))
          }
          rows={2}
          maxLength={4096}
        />
      </Label>
    </div>
  )
}
