import { useCallback, useEffect, useState } from 'react'
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
import { useToast } from '@/components/ui/toast'
import { deleteReq, getJson, patchJson, postJson } from '../lib/api'
import { formatMoney } from '../lib/formatMoney'
import { safeNum } from '../lib/num'

const INCOME_SOURCES = ['paycheck', 'invoice', 'cash', 'gift', 'refund', 'other'] as const
type IncomeSource = (typeof INCOME_SOURCES)[number]

type IncomeEntry = {
  id: number
  occurredOn: string
  grossAmountCents: number
  currency: string
  taxWithheldCents: number | null
  netAmountCents: number
  source: IncomeSource
  notes: string | null
  categoryId: number | null
  counterpartyContactId: number | null
  accountId: number | null
  linkedTransactionId: number | null
}

type FormState = {
  occurredOn: string
  grossAmountCents: string
  currency: string
  taxWithheldCents: string
  source: IncomeSource
  notes: string
}

const today = () => new Date().toISOString().slice(0, 10)

function emptyForm(): FormState {
  return {
    occurredOn: today(),
    grossAmountCents: '',
    currency: 'CAD',
    taxWithheldCents: '',
    source: 'paycheck',
    notes: '',
  }
}

function entryToForm(entry: IncomeEntry): FormState {
  return {
    occurredOn: entry.occurredOn,
    grossAmountCents: String(entry.grossAmountCents),
    currency: entry.currency,
    taxWithheldCents: entry.taxWithheldCents != null ? String(entry.taxWithheldCents) : '',
    source: entry.source,
    notes: entry.notes ?? '',
  }
}

export function IncomePage() {
  const { showToast } = useToast()
  const confirm = useConfirm()

  const [entries, setEntries] = useState<IncomeEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState<number | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm())
  const [formError, setFormError] = useState<string | null>(null)
  const [formSaving, setFormSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await getJson<{ entries: IncomeEntry[] }>('/api/income')
      setEntries(data.entries)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load income entries')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  function openCreate() {
    setEditId(null)
    setForm(emptyForm())
    setFormError(null)
    setShowForm(true)
  }

  function openEdit(entry: IncomeEntry) {
    setEditId(entry.id)
    setForm(entryToForm(entry))
    setFormError(null)
    setShowForm(true)
  }

  function cancelForm() {
    setShowForm(false)
    setEditId(null)
    setFormError(null)
  }

  function setField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  function computedNet(): number | null {
    const gross = safeNum(Number(form.grossAmountCents))
    const tax = form.taxWithheldCents ? safeNum(Number(form.taxWithheldCents)) : 0
    if (gross === null) return null
    return gross - (tax ?? 0)
  }

  function validate(): string | null {
    const gross = safeNum(Number(form.grossAmountCents))
    if (gross === null || gross <= 0) return 'Enter a positive amount.'
    if (form.taxWithheldCents) {
      const tax = safeNum(Number(form.taxWithheldCents))
      if (tax === null || tax < 0) return 'Tax withheld must be 0 or more.'
      if (tax > gross) return "Tax can't exceed gross."
    }
    return null
  }

  async function submit() {
    const err = validate()
    if (err) { setFormError(err); return; }
    setFormSaving(true)
    setFormError(null)
    try {
      const gross = Number(form.grossAmountCents)
      const tax = form.taxWithheldCents ? Number(form.taxWithheldCents) : null
      const payload = {
        occurredOn: form.occurredOn,
        grossAmountCents: gross,
        currency: form.currency,
        taxWithheldCents: tax,
        source: form.source,
        notes: form.notes || null,
      }
      if (editId !== null) {
        await patchJson<IncomeEntry>(`/api/income/${editId}`, payload)
        showToast({ title: 'Income entry updated', variant: 'success' })
      } else {
        await postJson<IncomeEntry>('/api/income', payload)
        showToast({ title: 'Income logged.', variant: 'success' })
      }
      cancelForm()
      await load()
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Could not save income entry')
    } finally {
      setFormSaving(false)
    }
  }

  async function deleteEntry(entry: IncomeEntry) {
    const ok = await confirm({
      title: 'Delete this income entry?',
      description: entry.linkedTransactionId
        ? 'The paired transaction in your account will also be deleted.'
        : undefined,
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    try {
      await deleteReq(`/api/income/${entry.id}`)
      await load()
      showToast({ title: 'Income entry deleted', variant: 'success' })
    } catch (e) {
      showToast({
        title: 'Could not delete',
        description: e instanceof Error ? e.message : undefined,
        variant: 'destructive',
      })
    }
  }

  const net = computedNet()

  return (
    <div className="page">
      {confirm.dialog}
      <PageHeader
        title="Income"
        description="Log manual income entries — paychecks, invoices, cash, and more."
        actions={
          <Button type="button" onClick={openCreate}>
            Log income
          </Button>
        }
      />

      {showForm && (
        <Card className="accountsFormCard" style={{ marginBottom: '1.5rem' }}>
          <h2 style={{ marginBottom: '1rem' }}>{editId !== null ? 'Edit income entry' : 'Log income'}</h2>
          <div className="formGrid" style={{ gap: '0.75rem' }}>
            <label>
              Date
              <Input
                type="date"
                value={form.occurredOn}
                onChange={(e) => setField('occurredOn', e.target.value)}
                disabled={formSaving}
              />
            </label>
            <label>
              Gross amount (cents)
              <Input
                type="number"
                min={1}
                placeholder="e.g. 500000 for $5000.00"
                value={form.grossAmountCents}
                onChange={(e) => setField('grossAmountCents', e.target.value)}
                disabled={formSaving}
              />
            </label>
            <label>
              Currency
              <Input
                value={form.currency}
                maxLength={3}
                style={{ textTransform: 'uppercase' }}
                onChange={(e) => setField('currency', e.target.value.toUpperCase())}
                disabled={formSaving}
              />
            </label>
            <label>
              Tax withheld (cents, optional)
              <Input
                type="number"
                min={0}
                placeholder="e.g. 150000 for $1500.00"
                value={form.taxWithheldCents}
                onChange={(e) => setField('taxWithheldCents', e.target.value)}
                disabled={formSaving}
              />
            </label>
            {net !== null && (
              <p className="muted" style={{ fontSize: '0.85rem' }}>
                Net: {formatMoney(net / 100, form.currency)}
              </p>
            )}
            <Label>
              Source
              <NativeSelect
                value={form.source}
                onChange={(e) => setField('source', e.target.value as IncomeSource)}
                disabled={formSaving}
              >
                {INCOME_SOURCES.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </NativeSelect>
            </Label>
            <label>
              Notes (optional)
              <Input
                value={form.notes}
                placeholder="Invoice #, project name, etc."
                onChange={(e) => setField('notes', e.target.value)}
                disabled={formSaving}
              />
            </label>
            {formError && <span className="error" role="alert">{formError}</span>}
            <div className="row" style={{ gap: '0.5rem' }}>
              <Button
                type="button"
                disabled={formSaving}
                onClick={() => void submit()}
              >
                {formSaving ? 'Saving…' : editId !== null ? 'Save' : 'Log income'}
              </Button>
              <Button type="button" variant="secondary" onClick={cancelForm} disabled={formSaving}>
                Cancel
              </Button>
            </div>
          </div>
        </Card>
      )}

      {loading && <p className="muted">Loading…</p>}
      {error && <p className="error" role="alert">{error}</p>}

      {!loading && !error && entries.length === 0 && (
        <EmptyState
          title="Log your first income entry."
          description="Track paychecks, invoices, cash payments, and more."
          actions={
            <Button type="button" onClick={openCreate}>Log income</Button>
          }
        />
      )}

      {entries.length > 0 && (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Gross</TableHead>
                <TableHead>Tax withheld</TableHead>
                <TableHead>Net</TableHead>
                <TableHead>Notes</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell>{entry.occurredOn}</TableCell>
                  <TableCell>{entry.source}</TableCell>
                  <TableCell>{formatMoney(entry.grossAmountCents / 100, entry.currency)}</TableCell>
                  <TableCell>
                    {entry.taxWithheldCents != null
                      ? formatMoney(entry.taxWithheldCents / 100, entry.currency)
                      : '—'}
                  </TableCell>
                  <TableCell>{formatMoney(entry.netAmountCents / 100, entry.currency)}</TableCell>
                  <TableCell>{entry.notes ?? '—'}</TableCell>
                  <TableCell>
                    <div className="row" style={{ gap: '0.5rem' }}>
                      <Button type="button" size="sm" variant="secondary" onClick={() => openEdit(entry)}>
                        Edit
                      </Button>
                      <Button type="button" size="sm" variant="destructive" onClick={() => void deleteEntry(entry)}>
                        Delete
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  )
}
