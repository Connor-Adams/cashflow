import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Plus, Pencil, Trash2 } from 'lucide-react'
import { Badge } from '@connor-adams/designsystem'
import { Button } from '@connor-adams/designsystem'
import { Card } from '@connor-adams/designsystem'
import { Dialog } from '@connor-adams/designsystem'
import { EmptyTableRow } from '@/lib/ds-extras'
import { Input } from '@connor-adams/designsystem'
import { Label } from '@connor-adams/designsystem'
import { NativeSelect } from '@connor-adams/designsystem'
import { PageHeader } from '@/components/ui/page-header'
import { SkeletonRow } from '@/lib/ds-extras'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@connor-adams/designsystem'
import { Textarea } from '@connor-adams/designsystem'
import { useToast } from '@/components/ui/toast'
import { deleteReq, getJson, patchJson, postJson } from '../lib/api'
import { todayDateInputValue } from '../lib/dateInput'
import { formatMoney } from '../lib/formatMoney'

export type IncomeSource =
  | 'paycheck'
  | 'invoice'
  | 'cash'
  | 'gift'
  | 'refund'
  | 'other'

export interface IncomeEntry {
  id: number
  userId: number
  householdId: number
  occurredOn: string
  grossAmountCents: number
  currency: string
  taxWithheldCents: number | null
  netAmountCents: number
  categoryId: number | null
  counterpartyContactId: number | null
  source: IncomeSource
  notes: string | null
  accountId: number | null
  linkedTransactionId: number | null
  createdAt: string
  updatedAt: string
}

interface IncomeListResponse {
  total: number
  items: IncomeEntry[]
}

const SOURCE_OPTIONS: ReadonlyArray<{ value: IncomeSource; label: string }> = [
  { value: 'paycheck', label: 'Paycheck' },
  { value: 'invoice', label: 'Invoice' },
  { value: 'cash', label: 'Cash' },
  { value: 'gift', label: 'Gift' },
  { value: 'refund', label: 'Refund' },
  { value: 'other', label: 'Other' },
]

const SOURCE_LABEL: Record<IncomeSource, string> = {
  paycheck: 'Paycheck',
  invoice: 'Invoice',
  cash: 'Cash',
  gift: 'Gift',
  refund: 'Refund',
  other: 'Other',
}

const SOURCE_VARIANT: Record<
  IncomeSource,
  'default' | 'secondary' | 'outline' | 'destructive'
> = {
  paycheck: 'default',
  invoice: 'default',
  cash: 'secondary',
  gift: 'secondary',
  refund: 'outline',
  other: 'outline',
}

const DEFAULT_CURRENCY = 'CAD'

interface FormState {
  occurredOn: string
  grossAmountDollars: string
  currency: string
  taxWithheldDollars: string
  source: IncomeSource
  notes: string
}

function emptyForm(): FormState {
  return {
    occurredOn: todayDateInputValue(),
    grossAmountDollars: '',
    currency: DEFAULT_CURRENCY,
    taxWithheldDollars: '',
    source: 'paycheck',
    notes: '',
  }
}

function centsFromDollars(s: string): number | null {
  const n = parseFloat(s)
  if (!isFinite(n) || n < 0) return null
  return Math.round(n * 100)
}

function dollarsFromCents(cents: number): string {
  return (cents / 100).toFixed(2)
}

interface LogDialogProps {
  open: boolean
  onOpenChange: (v: boolean) => void
  onSaved: (entry: IncomeEntry) => void
  editing: IncomeEntry | null
}

function LogDialog({ open, onOpenChange, onSaved, editing }: LogDialogProps) {
  const { showToast } = useToast()
  const [form, setForm] = useState<FormState>(emptyForm())
  const [saving, setSaving] = useState(false)
  const [grossError, setGrossError] = useState('')
  const [taxError, setTaxError] = useState('')

  useEffect(() => {
    if (open) {
      if (editing) {
        setForm({
          occurredOn: editing.occurredOn,
          grossAmountDollars: dollarsFromCents(editing.grossAmountCents),
          currency: editing.currency,
          taxWithheldDollars:
            editing.taxWithheldCents != null
              ? dollarsFromCents(editing.taxWithheldCents)
              : '',
          source: editing.source,
          notes: editing.notes ?? '',
        })
      } else {
        setForm(emptyForm())
      }
      setGrossError('')
      setTaxError('')
    }
  }, [open, editing])

  function set(field: keyof FormState, value: string) {
    setForm((f) => ({ ...f, [field]: value }))
  }

  function validate(): {
    grossAmountCents: number
    taxWithheldCents: number | null
  } | null {
    const grossRaw = parseFloat(form.grossAmountDollars)
    if (Number.isFinite(grossRaw) && grossRaw < 0) {
      setGrossError("Amount can't be negative.")
      return null
    }
    const gross = centsFromDollars(form.grossAmountDollars)
    if (gross === null || gross <= 0) {
      setGrossError('Enter a positive amount.')
      return null
    }
    setGrossError('')

    let tax: number | null = null
    if (form.taxWithheldDollars.trim()) {
      tax = centsFromDollars(form.taxWithheldDollars)
      if (tax === null) {
        setTaxError('Enter a non-negative amount.')
        return null
      }
      if (tax > gross) {
        setTaxError("Tax can't exceed gross.")
        return null
      }
    }
    setTaxError('')
    return { grossAmountCents: gross, taxWithheldCents: tax }
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const amounts = validate()
    if (!amounts) return
    setSaving(true)
    try {
      const body = {
        occurredOn: form.occurredOn,
        grossAmountCents: amounts.grossAmountCents,
        currency: form.currency.toUpperCase(),
        taxWithheldCents: amounts.taxWithheldCents,
        source: form.source,
        notes: form.notes.trim() || null,
      }
      let saved: IncomeEntry
      if (editing) {
        saved = await patchJson<IncomeEntry>(`/api/income/${editing.id}`, body)
      } else {
        saved = await postJson<IncomeEntry>('/api/income', body)
      }
      onSaved(saved)
      onOpenChange(false)
      showToast({ title: editing ? 'Income updated' : 'Income logged' })
    } catch (err) {
      showToast({
        title: editing ? 'Failed to update' : 'Failed to log income',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={() => onOpenChange(false)}
      title={<>{editing ? 'Edit income entry' : 'Log income'}</>}
    >
      <form onSubmit={handleSubmit}>
        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="income-date">Date</Label>
            <Input
              id="income-date"
              type="date"
              value={form.occurredOn}
              onChange={(e) => set('occurredOn', e.target.value)}
              required
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="income-source">Source</Label>
            <NativeSelect
              id="income-source"
              value={form.source}
              onChange={(e) => set('source', e.target.value as IncomeSource)}
            >
              {SOURCE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="income-gross">Gross amount</Label>
              <Input
                id="income-gross"
                type="number"
                min={0}
                step={0.01}
                placeholder="0.00"
                value={form.grossAmountDollars}
                onChange={(e) => set('grossAmountDollars', e.target.value)}
                required
                aria-invalid={grossError ? 'true' : undefined}
                aria-describedby={grossError ? 'income-gross-error' : undefined}
              />
              {grossError && (
                <p id="income-gross-error" className="text-sm text-destructive mt-1">
                  {grossError}
                </p>
              )}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="income-currency">Currency</Label>
              <Input
                id="income-currency"
                type="text"
                maxLength={3}
                placeholder="CAD"
                value={form.currency}
                onChange={(e) => set('currency', e.target.value)}
                required
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="income-tax">Tax withheld (optional)</Label>
            <Input
              id="income-tax"
              type="number"
              min={0}
              step={0.01}
              placeholder="0.00"
              value={form.taxWithheldDollars}
              onChange={(e) => set('taxWithheldDollars', e.target.value)}
            />
            {taxError && (
              <p className="text-xs text-destructive">{taxError}</p>
            )}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="income-notes">Notes (optional)</Label>
            <Textarea
              id="income-notes"
              rows={2}
              value={form.notes}
              onChange={(e) => set('notes', e.target.value)}
            />
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Log income'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

export function IncomePage() {
  const { showToast } = useToast()
  const [entries, setEntries] = useState<IncomeEntry[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<IncomeEntry | null>(null)
  const [deleting, setDeleting] = useState<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getJson<IncomeListResponse>('/api/income?limit=100')
      setEntries(data.items)
      setTotal(data.total)
    } catch {
      showToast({ title: 'Failed to load income', variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }, [showToast])

  useEffect(() => {
    void load()
  }, [load])

  function openCreate() {
    setEditing(null)
    setDialogOpen(true)
  }

  function openEdit(entry: IncomeEntry) {
    setEditing(entry)
    setDialogOpen(true)
  }

  function onSaved(entry: IncomeEntry) {
    setEntries((prev) => {
      const idx = prev.findIndex((e) => e.id === entry.id)
      if (idx >= 0) {
        const next = [...prev]
        next[idx] = entry
        return next
      }
      return [entry, ...prev]
    })
    setTotal((t) => (editing ? t : t + 1))
  }

  async function handleDelete(entry: IncomeEntry) {
    setDeleting(entry.id)
    try {
      await deleteReq(`/api/income/${entry.id}`)
      setEntries((prev) => prev.filter((e) => e.id !== entry.id))
      setTotal((t) => t - 1)
      showToast({ title: 'Entry deleted' })
    } catch {
      showToast({ title: 'Failed to delete entry', variant: 'destructive' })
    } finally {
      setDeleting(null)
    }
  }

  const netTotal = entries.reduce((sum, e) => sum + e.netAmountCents, 0)
  const grossTotal = entries.reduce((sum, e) => sum + e.grossAmountCents, 0)
  const primaryCurrency = entries[0]?.currency ?? DEFAULT_CURRENCY

  return (
    <div className="space-y-6">
      <PageHeader
        title="Income"
        description="Log and track your income events."
        actions={
          <Button onClick={openCreate}>
            <Plus className="mr-2 h-4 w-4" />
            Log income
          </Button>
        }
      />

      {!loading && entries.length > 0 && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Card className="p-4">
            <p className="text-xs text-muted-foreground">Gross (shown)</p>
            <p className="mt-1 text-lg font-semibold">
              {formatMoney(grossTotal / 100, primaryCurrency)}
            </p>
          </Card>
          <Card className="p-4">
            <p className="text-xs text-muted-foreground">Net (after tax)</p>
            <p className="mt-1 text-lg font-semibold">
              {formatMoney(netTotal / 100, primaryCurrency)}
            </p>
          </Card>
          <Card className="p-4">
            <p className="text-xs text-muted-foreground">Entries</p>
            <p className="mt-1 text-lg font-semibold">{total}</p>
          </Card>
        </div>
      )}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Source</TableHead>
            <TableHead className="text-right">Gross</TableHead>
            <TableHead className="text-right">Tax withheld</TableHead>
            <TableHead className="text-right">Net</TableHead>
            <TableHead>Notes</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            Array.from({ length: 5 }).map((_, i) => (
              <SkeletonRow key={i} cols={7} />
            ))
          ) : entries.length === 0 ? (
            <EmptyTableRow
              colSpan={7}
              title="No income entries yet. Click 'Log income' to add one."
            />
          ) : (
            entries.map((entry) => (
              <TableRow key={entry.id}>
                <TableCell className="whitespace-nowrap">
                  {entry.occurredOn}
                </TableCell>
                <TableCell>
                  <Badge variant={SOURCE_VARIANT[entry.source]}>
                    {SOURCE_LABEL[entry.source]}
                  </Badge>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatMoney(entry.grossAmountCents / 100, entry.currency)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {entry.taxWithheldCents != null
                    ? formatMoney(
                        entry.taxWithheldCents / 100,
                        entry.currency,
                      )
                    : '—'}
                </TableCell>
                <TableCell className="text-right tabular-nums font-medium">
                  {formatMoney(entry.netAmountCents / 100, entry.currency)}
                </TableCell>
                <TableCell className="max-w-[200px] truncate text-muted-foreground">
                  {entry.notes ?? '—'}
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => openEdit(entry)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      <span className="sr-only">Edit</span>
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleDelete(entry)}
                      disabled={deleting === entry.id}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      <span className="sr-only">Delete</span>
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      <LogDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSaved={onSaved}
        editing={editing}
      />
    </div>
  )
}
