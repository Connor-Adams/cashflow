/**
 * Shared field grid for create/edit planned-event forms. Reused by both
 * `PlannedEventsPage` and `CalendarPage`. Lives in its own file so the
 * react-refresh lint rule stays happy (components-only export per file).
 */
import { Input } from '@cashflow/ui'
import { Label } from '@cashflow/ui'
import { NativeSelect } from '@cashflow/ui'
import { Textarea } from '@cashflow/ui'
import type { Account, PlannedEventStatus, PlannedEventType } from '../../types/api'
import {
  PLANNED_EVENT_STATUS_OPTIONS,
  PLANNED_EVENT_TYPE_OPTIONS,
  type FormState,
} from './plannedEventForm'
import { RecurrencePicker } from './RecurrencePicker'

type PlannedEventFormFieldsProps = {
  form: FormState
  setForm: (updater: (prev: FormState) => FormState) => void
  accountOptions: Account[]
  idPrefix: string
  showStatus: boolean
}

export function PlannedEventFormFields({
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
        <RecurrencePicker
          id={`${idPrefix}-recurrence`}
          value={form.recurrenceRule}
          expectedDate={form.expectedDate}
          onChange={(rrule) =>
            setForm((prev) => ({ ...prev, recurrenceRule: rrule }))
          }
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
