import { useState, useEffect, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import { useToast } from '@/components/ui/toast'
import { postJson, patchJson } from '@/lib/api'

const INCOME_SOURCES = [
  { value: 'paycheck', label: 'Paycheck' },
  { value: 'invoice', label: 'Invoice' },
  { value: 'cash', label: 'Cash' },
  { value: 'gift', label: 'Gift' },
  { value: 'refund', label: 'Refund' },
  { value: 'other', label: 'Other' },
]

type IncomeFormState = {
  occurredOn: string
  source: string
  grossAmountCents: string
  currency: string
  taxWithheldCents: string
  categoryId: string
  counterpartyContactId: string
  accountId: string
  notes: string
}

function emptyForm(): IncomeFormState {
  return {
    occurredOn: new Date().toISOString().slice(0, 10),
    source: 'paycheck',
    grossAmountCents: '',
    currency: 'CAD',
    taxWithheldCents: '',
    categoryId: '',
    counterpartyContactId: '',
    accountId: '',
    notes: '',
  }
}

type Props = {
  editEntry?: { id: number } & Partial<IncomeFormState>
  onClose: () => void
  onSaved: () => void
}

export function LogIncomeModal({ editEntry, onClose, onSaved }: Props) {
  const { showToast } = useToast()
  const [form, setForm] = useState<IncomeFormState>(() => {
    if (editEntry) {
      return {
        ...emptyForm(),
        ...editEntry,
        grossAmountCents: editEntry.grossAmountCents ?? '',
        taxWithheldCents: editEntry.taxWithheldCents ?? '',
      }
    }
    return emptyForm()
  })
  const [submitting, setSubmitting] = useState(false)
  const [errors, setErrors] = useState<{ gross?: string; tax?: string }>({})

  const grossCents = Number(form.grossAmountCents)
  const taxCents = Number(form.taxWithheldCents || '0')
  const netCents = grossCents - taxCents

  // Auto-compute net display
  useEffect(() => {
    const errs: { gross?: string; tax?: string } = {}
    if (form.grossAmountCents && grossCents <= 0) errs.gross = 'Enter a positive amount.'
    if (form.taxWithheldCents && taxCents > grossCents) errs.tax = "Tax can't exceed gross."
    setErrors(errs)
  }, [form.grossAmountCents, form.taxWithheldCents, grossCents, taxCents])

  function set(key: keyof IncomeFormState, value: string) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (Object.keys(errors).length > 0) return
    if (!form.grossAmountCents || grossCents <= 0) {
      setErrors({ gross: 'Enter a positive amount.' })
      return
    }
    setSubmitting(true)
    try {
      const payload = {
        occurredOn: form.occurredOn,
        grossAmountCents: String(Math.round(grossCents)),
        currency: form.currency,
        taxWithheldCents: form.taxWithheldCents ? String(Math.round(taxCents)) : undefined,
        source: form.source,
        notes: form.notes || undefined,
        categoryId: form.categoryId ? Number(form.categoryId) : undefined,
        counterpartyContactId: form.counterpartyContactId ? Number(form.counterpartyContactId) : undefined,
        accountId: form.accountId ? Number(form.accountId) : undefined,
      }
      if (editEntry?.id) {
        await patchJson(`/api/income/${editEntry.id}`, payload)
        showToast({ title: 'Income updated.', variant: 'success' })
      } else {
        await postJson('/api/income', payload)
        showToast({ title: 'Income logged.', variant: 'success' })
      }
      onSaved()
      onClose()
    } catch (err) {
      showToast({
        title: err instanceof Error ? err.message : 'Could not save income entry',
        variant: 'destructive',
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Log income"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-card rounded-lg shadow-lg w-full max-w-lg p-6 space-y-4">
        <h2 className="text-lg font-semibold">{editEntry ? 'Edit income entry' : 'Log income'}</h2>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="income-date">Date</Label>
              <Input
                id="income-date"
                type="date"
                value={form.occurredOn}
                onChange={(e) => set('occurredOn', e.target.value)}
                required
              />
            </div>
            <div>
              <Label htmlFor="income-source">Source</Label>
              <NativeSelect
                id="income-source"
                value={form.source}
                onChange={(e) => set('source', e.target.value)}
              >
                {INCOME_SOURCES.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </NativeSelect>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <Label htmlFor="income-gross">Gross amount (cents)</Label>
              <Input
                id="income-gross"
                type="number"
                min={1}
                step={1}
                placeholder="e.g. 500000"
                value={form.grossAmountCents}
                onChange={(e) => set('grossAmountCents', e.target.value)}
                required
              />
              {errors.gross && <p className="text-xs text-destructive mt-1">{errors.gross}</p>}
            </div>
            <div>
              <Label htmlFor="income-currency">Currency</Label>
              <Input
                id="income-currency"
                maxLength={3}
                value={form.currency}
                onChange={(e) => set('currency', e.target.value.toUpperCase())}
              />
            </div>
          </div>

          <div>
            <Label htmlFor="income-tax">Tax withheld (cents, optional)</Label>
            <Input
              id="income-tax"
              type="number"
              min={0}
              step={1}
              placeholder="e.g. 120000"
              value={form.taxWithheldCents}
              onChange={(e) => set('taxWithheldCents', e.target.value)}
            />
            {errors.tax && <p className="text-xs text-destructive mt-1">{errors.tax}</p>}
          </div>

          <div>
            <Label>Net (auto-computed)</Label>
            <p className="text-sm font-medium mt-1">
              {Number.isFinite(netCents) && grossCents > 0 && taxCents <= grossCents
                ? `${netCents} cents`
                : '—'}
            </p>
          </div>

          <div>
            <Label htmlFor="income-notes">Notes (optional)</Label>
            <Input
              id="income-notes"
              value={form.notes}
              onChange={(e) => set('notes', e.target.value)}
              placeholder="Optional notes"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || Object.keys(errors).length > 0}>
              {submitting ? 'Saving…' : editEntry ? 'Save' : 'Log income'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
