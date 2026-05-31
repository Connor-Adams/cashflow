/**
 * Manual income entry page (issue #434).
 *
 * Records actual income (paycheck, invoice, cash, gift, etc.) with optional
 * gross / tax-withheld breakdown. Stored as a Transaction with txnType='income'
 * so it automatically feeds the cashflow and partner-fairness surfaces.
 */
import { useEffect, useRef, useState } from 'react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useToast } from '@/components/ui/toast'
import { deleteReq, getJson, postJson } from '../lib/api'
import { formatMoney } from '../lib/formatMoney'
import type { Account } from '../types/api'

type IncomeSource = 'paycheck' | 'invoice' | 'cash' | 'gift' | 'refund' | 'other'

const SOURCE_OPTIONS: { value: IncomeSource; label: string }[] = [
  { value: 'paycheck', label: 'Paycheck / Salary' },
  { value: 'invoice', label: 'Invoice / Freelance' },
  { value: 'cash', label: 'Cash' },
  { value: 'gift', label: 'Gift' },
  { value: 'refund', label: 'Refund' },
  { value: 'other', label: 'Other' },
]

type IncomeEntry = {
  id: number
  date: string
  merchantClean: string
  amount: string
  currency: string
  grossAmount: string | null
  taxWithheld: string | null
  incomeSource: IncomeSource | null
  notes: string | null
  finalCategory: string | null
  accountId: number | null
}

type ListResponse = {
  total: number
  entries: IncomeEntry[]
}

const today = new Date().toISOString().slice(0, 10)

function emptyForm() {
  return {
    occurredOn: today,
    grossAmount: '',
    taxWithheld: '',
    currency: 'CAD',
    source: 'paycheck' as IncomeSource,
    merchantClean: '',
    notes: '',
    category: '',
  }
}

export function IncomePage() {
  const { showToast } = useToast()
  const [entries, setEntries] = useState<IncomeEntry[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [accounts, setAccounts] = useState<Account[]>([])
  const [form, setForm] = useState(emptyForm())
  const [saving, setSaving] = useState(false)
  const firstFieldRef = useRef<HTMLInputElement>(null)

  async function load() {
    setLoading(true)
    try {
      const res = await getJson<ListResponse>('/api/income')
      setEntries(res.entries)
      setTotal(res.total)
    } catch (e) {
      showToast({ title: e instanceof Error ? e.message : 'Failed to load', variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    void getJson<Account[]>('/api/accounts').then(setAccounts).catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    const gross = parseFloat(form.grossAmount)
    if (!Number.isFinite(gross) || gross <= 0) {
      showToast({ title: 'Enter a positive gross amount.', variant: 'destructive' })
      return
    }
    setSaving(true)
    try {
      await postJson('/api/income', {
        occurredOn: form.occurredOn,
        grossAmount: gross,
        taxWithheld: form.taxWithheld ? parseFloat(form.taxWithheld) : 0,
        currency: form.currency.toUpperCase().slice(0, 3),
        source: form.source,
        merchantClean: form.merchantClean.trim() || undefined,
        notes: form.notes.trim() || undefined,
        category: form.category.trim() || undefined,
      })
      setForm(emptyForm())
      firstFieldRef.current?.focus()
      await load()
      showToast({ title: 'Income recorded.', variant: 'success' })
    } catch (e) {
      showToast({ title: e instanceof Error ? e.message : 'Failed to save', variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  async function remove(id: number) {
    try {
      await deleteReq(`/api/income/${id}`)
      setEntries((prev) => prev.filter((e) => e.id !== id))
      setTotal((n) => n - 1)
      showToast({ title: 'Entry deleted.', variant: 'success' })
    } catch (e) {
      showToast({ title: e instanceof Error ? e.message : 'Delete failed', variant: 'destructive' })
    }
  }

  const gross = parseFloat(form.grossAmount) || 0
  const tax = parseFloat(form.taxWithheld) || 0
  const net = gross - tax

  return (
    <div className="page">
      <PageHeader
        title="Log income"
        description="Record actual income with gross, tax withheld, and net breakdown."
      />

      <form className="card" onSubmit={onSubmit}>
        <h2 className="text-base font-semibold mb-3">New income entry</h2>
        <div className="formGrid">
          <Label htmlFor="income-date">
            Date
            <Input
              id="income-date"
              ref={firstFieldRef}
              type="date"
              value={form.occurredOn}
              onChange={(e) => setForm((f) => ({ ...f, occurredOn: e.target.value }))}
              required
            />
          </Label>
          <Label htmlFor="income-source">
            Source
            <NativeSelect
              id="income-source"
              value={form.source}
              onChange={(e) => setForm((f) => ({ ...f, source: e.target.value as IncomeSource }))}
            >
              {SOURCE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </NativeSelect>
          </Label>
          <Label htmlFor="income-gross">
            Gross amount
            <Input
              id="income-gross"
              type="number"
              step="0.01"
              min="0"
              placeholder="0.00"
              value={form.grossAmount}
              onChange={(e) => setForm((f) => ({ ...f, grossAmount: e.target.value }))}
              required
            />
          </Label>
          <Label htmlFor="income-tax">
            Tax withheld
            <Input
              id="income-tax"
              type="number"
              step="0.01"
              min="0"
              placeholder="0.00"
              value={form.taxWithheld}
              onChange={(e) => setForm((f) => ({ ...f, taxWithheld: e.target.value }))}
            />
          </Label>
          <Label htmlFor="income-currency">
            Currency
            <Input
              id="income-currency"
              value={form.currency}
              onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value.toUpperCase().slice(0, 3) }))}
              maxLength={3}
              required
            />
          </Label>
          <Label htmlFor="income-desc">
            Description (optional)
            <Input
              id="income-desc"
              placeholder="Employer name, client, etc."
              value={form.merchantClean}
              onChange={(e) => setForm((f) => ({ ...f, merchantClean: e.target.value }))}
              maxLength={255}
            />
          </Label>
          <Label htmlFor="income-category">
            Category (optional)
            <Input
              id="income-category"
              placeholder="Income"
              value={form.category}
              onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
            />
          </Label>
          <Label htmlFor="income-notes">
            Notes (optional)
            <Input
              id="income-notes"
              placeholder="Invoice #, project, etc."
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            />
          </Label>
        </div>
        {gross > 0 && (
          <p className="muted text-sm mt-2">
            Net: <strong>{formatMoney(net, form.currency)}</strong>
            {tax > 0 && ` (${formatMoney(gross, form.currency)} gross − ${formatMoney(tax, form.currency)} withheld)`}
          </p>
        )}
        <div className="mt-3">
          <Button type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Log income'}
          </Button>
        </div>
      </form>

      <section className="card mt-4">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 12 }}>
          <h2 className="text-base font-semibold">Income log</h2>
          <span className="muted text-sm">{total} entr{total === 1 ? 'y' : 'ies'}</span>
        </div>
        <div className="tableWrap" aria-busy={loading}>
          <Table className="table">
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Gross</TableHead>
                <TableHead>Tax withheld</TableHead>
                <TableHead>Net</TableHead>
                <TableHead>Category</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.length === 0 && !loading ? (
                <TableRow>
                  <TableCell colSpan={8} className="emptyStateCell">
                    <p>No income entries yet. Log your first one above.</p>
                  </TableCell>
                </TableRow>
              ) : (
                entries.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell>{entry.date}</TableCell>
                    <TableCell>{entry.incomeSource ?? '—'}</TableCell>
                    <TableCell>{entry.merchantClean}</TableCell>
                    <TableCell>
                      {entry.grossAmount
                        ? formatMoney(Number(entry.grossAmount), entry.currency)
                        : '—'}
                    </TableCell>
                    <TableCell>
                      {entry.taxWithheld && Number(entry.taxWithheld) > 0
                        ? formatMoney(Number(entry.taxWithheld), entry.currency)
                        : '—'}
                    </TableCell>
                    <TableCell>{formatMoney(Number(entry.amount), entry.currency)}</TableCell>
                    <TableCell>{entry.finalCategory ?? '—'}</TableCell>
                    <TableCell>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => void remove(entry.id)}
                      >
                        Delete
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </section>
    </div>
  )
}
