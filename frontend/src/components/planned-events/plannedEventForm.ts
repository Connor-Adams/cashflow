/**
 * Shared types + form helpers for planned events. Lives here (rather than
 * inside PlannedEventsPage.tsx) so multiple pages — PlannedEventsPage and
 * CalendarPage — can import the same form state shape without tripping the
 * react-refresh lint rule about mixing component + non-component exports
 * in the same module.
 */
import type {
  PlannedEvent,
  PlannedEventInput,
  PlannedEventPatch,
  PlannedEventSource,
  PlannedEventStatus,
  PlannedEventType,
} from '../../types/api'

export const DEFAULT_CURRENCY = 'CAD'

export const PLANNED_EVENT_TYPE_OPTIONS: Array<{ value: PlannedEventType; label: string }> = [
  { value: 'income', label: 'Income' },
  { value: 'expense', label: 'Expense' },
  { value: 'transfer', label: 'Transfer' },
  { value: 'settlement', label: 'Settlement' },
  { value: 'debt_payment', label: 'Debt payment' },
  { value: 'savings', label: 'Savings' },
]

export const PLANNED_EVENT_STATUS_OPTIONS: Array<{ value: PlannedEventStatus; label: string }> = [
  { value: 'planned', label: 'Planned' },
  { value: 'posted', label: 'Posted' },
  { value: 'skipped', label: 'Skipped' },
  { value: 'ignored', label: 'Ignored' },
]

// Tailwind v4 JIT needs literal class names — Sidebar/Theme docs note this.
// Look up colour classes per status/type via tables instead of building
// strings dynamically so the bundler keeps them.
export const STATUS_BADGE: Record<PlannedEventStatus, string> = {
  planned: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-100',
  posted: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-100',
  skipped: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-100',
  ignored: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-100',
}

export const TYPE_TONE: Record<PlannedEventType, 'inflow' | 'outflow' | 'neutral'> = {
  income: 'inflow',
  expense: 'outflow',
  transfer: 'neutral',
  settlement: 'neutral',
  debt_payment: 'outflow',
  savings: 'outflow',
}

export const TYPE_TONE_CLASS: Record<'inflow' | 'outflow' | 'neutral', string> = {
  inflow: 'text-emerald-600 dark:text-emerald-300',
  outflow: 'text-rose-600 dark:text-rose-300',
  neutral: 'text-zinc-600 dark:text-zinc-300',
}

export function typeLabel(type: PlannedEventType): string {
  return (
    PLANNED_EVENT_TYPE_OPTIONS.find((o) => o.value === type)?.label ?? type
  )
}

export function statusLabel(status: PlannedEventStatus): string {
  return (
    PLANNED_EVENT_STATUS_OPTIONS.find((o) => o.value === status)?.label ??
    status
  )
}

export type FormState = {
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

export function emptyForm(currency: string = DEFAULT_CURRENCY): FormState {
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

export function rowToForm(row: PlannedEvent): FormState {
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

export function buildInput(
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

export function buildPatch(form: FormState): PlannedEventPatch | null {
  const input = buildInput(form)
  if (!input) return null
  // For edit we don't change `source` (the originating subsystem owns it).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { source: _ignored, ...rest } = input
  return rest
}
