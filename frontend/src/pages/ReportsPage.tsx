import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  useConfirm,
} from '@/components/ui/dialog'
import { FilterBar, type QuickRange } from '@/components/ui/filter-bar'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select'
import { PageHeader } from '@/components/ui/page-header'
import { useToast } from '@/components/ui/toast'
import { toDateInputValue } from '../lib/dateInput'
import { formatMoney } from '../lib/formatMoney'
import { summaryQueryString } from '../lib/summaryQuery'
import { deleteReq, getJson, postJson } from '../lib/api'
import { useSessionState } from '../lib/useSessionState'
import type {
  Contact,
  PartnerSettlement,
  PartnerSettlementDirection,
  PartnerSettlementInput,
  PartnerSettlementsResponse,
} from '../types/api'

type PartnerNetDirection = 'partner_owes_me' | 'i_owe_partner' | 'even'

type PartnerRow = {
  currency: string
  ownershipType?: string
  ownershipContactId?: number | null
  contactName?: string | null
  sumMy: number
  sumPartner: number
  /** Raw net before subtracting settlements: sumPartner - sumMy. */
  rawNet: number
  /**
   * Signed sum of settlements applied to this (contact, currency) row:
   *   settledAmount = sum(i_paid_partner) - sum(partner_paid_me)
   * So `net = rawNet + settledAmount`.
   */
  settledAmount: number
  /** Number of settlement directions that contributed (0, 1, or 2). */
  settlementCount: number
  /** Adjusted net: rawNet + settledAmount. */
  net: number
  direction: PartnerNetDirection
}

type BusRow = { currency: string; sumBusiness: number }
const DEFAULT_REPORTS_CURRENCY = 'CAD'

function getRelativeDateRange(days: number): { from: string; to: string } {
  const to = new Date()
  const from = new Date(to)
  from.setDate(from.getDate() - days)
  return { from: toDateInputValue(from), to: toDateInputValue(to) }
}

function getYearToDateRange(): { from: string; to: string } {
  const to = new Date()
  const from = new Date(to.getFullYear(), 0, 1)
  return { from: toDateInputValue(from), to: toDateInputValue(to) }
}

export function ReportsPage() {
  const [currency, setCurrency] = useSessionState(
    'reports.currency',
    DEFAULT_REPORTS_CURRENCY
  )
  const [dateFrom, setDateFrom] = useSessionState('reports.dateFrom', '')
  const [dateTo, setDateTo] = useSessionState('reports.dateTo', '')
  const [partner, setPartner] = useState<{ byCurrency: PartnerRow[] } | null>(
    null
  )
  const [business, setBusiness] = useState<{ byCurrency: BusRow[] } | null>(
    null
  )
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [contacts, setContacts] = useState<Contact[]>([])
  const [settlements, setSettlements] = useState<PartnerSettlement[]>([])
  const [settlementsErr, setSettlementsErr] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [formContactId, setFormContactId] = useState<string>('')
  const [formDirection, setFormDirection] =
    useState<PartnerSettlementDirection>('i_paid_partner')
  const [formCurrency, setFormCurrency] = useState<string>('CAD')
  const [formAmount, setFormAmount] = useState<string>('')
  const [formDate, setFormDate] = useState<string>('')
  const [formNotes, setFormNotes] = useState<string>('')
  const [formSubmitting, setFormSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const { showToast } = useToast()
  const confirm = useConfirm()

  const summaryQs = useMemo(
    () => summaryQueryString({ currency, dateFrom, dateTo }),
    [currency, dateFrom, dateTo]
  )
  const quickRanges = useMemo<QuickRange[]>(
    () => [
      { key: '30d', label: '30 days', ...getRelativeDateRange(30) },
      { key: '90d', label: '90 days', ...getRelativeDateRange(90) },
      { key: 'ytd', label: 'YTD', ...getYearToDateRange() },
      { key: 'all', label: 'All time', from: '', to: '' },
    ],
    []
  )
  const hasActiveFilters =
    currency !== DEFAULT_REPORTS_CURRENCY || Boolean(dateFrom) || Boolean(dateTo)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setErr(null)
      try {
        const [p, b] = await Promise.all([
          getJson<{ byCurrency: PartnerRow[] }>(
            `/api/summary/partner${summaryQs}`
          ),
          getJson<{ byCurrency: BusRow[] }>(
            `/api/summary/business${summaryQs}`
          ),
        ])
        if (!cancelled) {
          setPartner(p)
          setBusiness(b)
        }
      } catch (e) {
        if (!cancelled)
          setErr(e instanceof Error ? e.message : 'Error')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [summaryQs])

  const loadSettlements = useCallback(async () => {
    try {
      const res = await getJson<PartnerSettlementsResponse>('/api/settlements')
      setSettlements(res.data)
    } catch (e) {
      setSettlementsErr(e instanceof Error ? e.message : 'Error')
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const list = await getJson<Contact[]>('/api/contacts')
        if (!cancelled) setContacts(list)
      } catch (e) {
        if (!cancelled)
          setSettlementsErr(e instanceof Error ? e.message : 'Error')
      }
    })()
    void loadSettlements()
    return () => {
      cancelled = true
    }
  }, [loadSettlements])

  const reportCurrencies = useMemo(() => {
    const found = new Set<string>()
    partner?.byCurrency.forEach((row) => {
      if (!currency || row.currency === currency) found.add(row.currency)
    })
    business?.byCurrency.forEach((row) => {
      if (!currency || row.currency === currency) found.add(row.currency)
    })
    return Array.from(found).sort()
  }, [partner, business, currency])

  // Unfiltered set of currencies present in the loaded data — used to
  // populate the currency picker so changing selection does not collapse
  // the options. The currently selected currency and the default are
  // always included so the picker stays usable even before data loads.
  const availableCurrencies = useMemo(() => {
    const found = new Set<string>()
    partner?.byCurrency.forEach((row) => found.add(row.currency))
    business?.byCurrency.forEach((row) => found.add(row.currency))
    found.add(DEFAULT_REPORTS_CURRENCY)
    if (currency) found.add(currency)
    return Array.from(found).sort()
  }, [partner, business, currency])

  const singleCurrency = currency || (reportCurrencies.length === 1 ? reportCurrencies[0] : '')
  const partnerMineTotal = useMemo(
    () =>
      (partner?.byCurrency ?? [])
        .filter((row) => !currency || row.currency === currency)
        .reduce((sum, row) => sum + row.sumMy, 0),
    [partner, currency]
  )
  const partnerShareTotal = useMemo(
    () =>
      (partner?.byCurrency ?? [])
        .filter((row) => !currency || row.currency === currency)
        .reduce((sum, row) => sum + row.sumPartner, 0),
    [partner, currency]
  )
  const businessTotal = useMemo(
    () =>
      (business?.byCurrency ?? [])
        .filter((row) => !currency || row.currency === currency)
        .reduce((sum, row) => sum + row.sumBusiness, 0),
    [business, currency]
  )
  const activeRangeLabel = useMemo(() => {
    if (!dateFrom && !dateTo) return 'All dates'
    if (dateFrom && dateTo) return `${dateFrom} to ${dateTo}`
    if (dateFrom) return `From ${dateFrom}`
    return `Up to ${dateTo}`
  }, [dateFrom, dateTo])
  const totalPartnerRows = partner?.byCurrency.filter((row) => !currency || row.currency === currency).length ?? 0
  const totalBusinessRows =
    business?.byCurrency.filter((row) => !currency || row.currency === currency).length ?? 0
  const partnerNetByCurrency = useMemo(() => {
    const map = new Map<string, number>()
    partner?.byCurrency.forEach((r) => {
      if (!currency || r.currency === currency) {
        map.set(r.currency, (map.get(r.currency) ?? 0) + r.net)
      }
    })
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b))
  }, [partner, currency])
  const showPartnerRollup =
    (partner?.byCurrency.filter((r) => !currency || r.currency === currency).length ?? 0) > 1
  const moneySummaryHint = singleCurrency
    ? `In ${singleCurrency}`
    : 'Set one currency to see money totals'

  const recentSettlements = useMemo(
    () => settlements.slice(0, 10),
    [settlements]
  )
  const directionLabel = (dir: PartnerSettlementDirection) =>
    dir === 'i_paid_partner' ? 'I paid partner' : 'Partner paid me'
  const directionBadgeVariant = (dir: PartnerSettlementDirection) =>
    dir === 'i_paid_partner' ? 'secondary' : 'default'

  function openSettlementDialog() {
    setFormError(null)
    setFormContactId(contacts.length > 0 ? String(contacts[0].id) : '')
    setFormDirection('i_paid_partner')
    setFormCurrency(currency || DEFAULT_REPORTS_CURRENCY)
    setFormAmount('')
    setFormDate(toDateInputValue(new Date()))
    setFormNotes('')
    setDialogOpen(true)
  }

  async function submitSettlement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFormError(null)
    const contactIdNumber = Number(formContactId)
    const amountNumber = Number(formAmount)
    if (!Number.isInteger(contactIdNumber) || contactIdNumber < 1) {
      setFormError('Choose a contact')
      return
    }
    if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
      setFormError('Amount must be greater than zero')
      return
    }
    if (!formDate) {
      setFormError('Pick a date')
      return
    }
    const body: PartnerSettlementInput = {
      contactId: contactIdNumber,
      direction: formDirection,
      currency: formCurrency.toUpperCase(),
      amount: amountNumber,
      settledDate: formDate,
      notes: formNotes.trim() ? formNotes.trim() : null,
    }
    setFormSubmitting(true)
    try {
      const created = await postJson<PartnerSettlement>(
        '/api/settlements',
        body
      )
      setDialogOpen(false)
      showToast({
        title: `Recorded settlement of ${formatMoney(amountNumber, body.currency)}`,
        variant: 'success',
      })
      // Optimistically prepend, then refetch to canonicalize ordering.
      setSettlements((prev) => [created, ...prev])
      await loadSettlements()
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Could not save')
    } finally {
      setFormSubmitting(false)
    }
  }

  async function removeSettlement(row: PartnerSettlement) {
    const ok = await confirm({
      title: 'Delete settlement?',
      description: `${row.settledDate} - ${formatMoney(Number(row.amount), row.currency)}`,
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    try {
      await deleteReq(`/api/settlements/${row.id}`)
      setSettlements((prev) => prev.filter((s) => s.id !== row.id))
    } catch (e) {
      setSettlementsErr(e instanceof Error ? e.message : 'Could not delete')
    }
  }

  return (
    <>
    <div className="page">
      <PageHeader
        title="Reports"
        description="Partner balances and business totals stay separated by currency and time window."
      />
      <section className="card reportsFilters">
        <FilterBar
          currency={currency}
          onCurrencyChange={setCurrency}
          availableCurrencies={availableCurrencies}
          dateFrom={dateFrom}
          dateTo={dateTo}
          onDateChange={(from, to) => {
            setDateFrom(from)
            setDateTo(to)
          }}
          quickRanges={quickRanges}
          quickRangesLabel="Quick report date ranges"
          actions={
            hasActiveFilters ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setCurrency(DEFAULT_REPORTS_CURRENCY)
                  setDateFrom('')
                  setDateTo('')
                }}
              >
                Clear filters
              </Button>
            ) : null
          }
          caption={
            <p className="muted" style={{ marginBottom: 0 }}>
              Showing <strong>{currency || 'all currencies'}</strong> for{' '}
              <strong>{activeRangeLabel}</strong>.
            </p>
          }
        />
      </section>
      {err && <span className="error">{err}</span>}
      {loading && <p className="muted">Loading…</p>}

      <section className="reportsStats" aria-busy={loading}>
        <article className="card statCard">
          <p className="statLabel">My share</p>
          <p className="statValue">
            {singleCurrency ? formatMoney(partnerMineTotal, singleCurrency) : `${reportCurrencies.length} currencies`}
          </p>
          <p className="muted statHint">{moneySummaryHint}</p>
        </article>
        <article className="card statCard">
          <p className="statLabel">Partner share</p>
          <p className="statValue">
            {singleCurrency
              ? formatMoney(partnerShareTotal, singleCurrency)
              : `${reportCurrencies.length} currencies`}
          </p>
          <p className="muted statHint">{moneySummaryHint}</p>
        </article>
        <article className="card statCard">
          <p className="statLabel">Business total</p>
          <p className="statValue">
            {singleCurrency ? formatMoney(businessTotal, singleCurrency) : `${reportCurrencies.length} currencies`}
          </p>
          <p className="muted statHint">{moneySummaryHint}</p>
        </article>
        <article className="card statCard">
          <p className="statLabel">Currencies</p>
          <p className="statValue">{reportCurrencies.length}</p>
          <p className="muted statHint">
            {totalPartnerRows} partner row{totalPartnerRows === 1 ? '' : 's'} and{' '}
            {totalBusinessRows} business row{totalBusinessRows === 1 ? '' : 's'}
          </p>
        </article>
      </section>

      <div className="reportsGrid">
        <section className="card reportsTableCard">
          <div className="reportsCardHeader">
            <div>
              <h2>Partner split totals</h2>
              <p className="muted">How much of the selected spend belongs to each person.</p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={openSettlementDialog}
              disabled={contacts.length === 0}
              title={
                contacts.length === 0
                  ? 'Add a contact in Settings before recording a settlement'
                  : undefined
              }
            >
              <Plus aria-hidden="true" />
              Record settlement
            </Button>
          </div>
          {showPartnerRollup && (
            <ul className="partnerNetRollup" style={{ listStyle: 'none', padding: 0, margin: '0 0 0.75rem 0', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
              {partnerNetByCurrency.map(([cur, total]) => {
                const rounded = Math.round(total * 100) / 100
                if (rounded === 0) {
                  return (
                    <li key={cur} className="muted" style={{ fontSize: '0.875rem' }}>
                      <strong>{cur}</strong>: even
                    </li>
                  )
                }
                const partnerOwesMe = rounded > 0
                const color = partnerOwesMe ? 'var(--accent-green)' : 'var(--danger)'
                const label = partnerOwesMe ? 'partner owes you' : 'you owe partner'
                return (
                  <li key={cur} style={{ fontSize: '0.875rem' }}>
                    <strong>{cur}</strong>:{' '}
                    <span style={{ color, fontWeight: 600 }}>
                      {formatMoney(Math.abs(rounded), cur)}
                    </span>{' '}
                    <span className="muted">({label})</span>
                  </li>
                )
              })}
            </ul>
          )}
          <div className="tableWrap" aria-busy={loading}>
            <table className="table">
              <thead>
                <tr>
                  <th>Currency</th>
                  <th>Ownership</th>
                  <th>My share</th>
                  <th>Partner share</th>
                  <th>Net</th>
                </tr>
              </thead>
              <tbody>
                {(partner?.byCurrency.length ?? 0) === 0 && !loading && (
                  <tr>
                    <td colSpan={5} className="emptyStateCell">
                      <p className="emptyState">
                        No partner-split data for these filters. Import transactions or widen the date range.
                      </p>
                    </td>
                  </tr>
                )}
                {partner?.byCurrency.map((r) => {
                  let netInner
                  if (r.direction === 'even') {
                    netInner = <span className="muted">Even</span>
                  } else {
                    const partnerOwesMe = r.direction === 'partner_owes_me'
                    const color = partnerOwesMe ? 'var(--accent-green)' : 'var(--danger)'
                    const sign = partnerOwesMe ? '+' : '−'
                    const label = partnerOwesMe ? 'partner owes you' : 'you owe partner'
                    netInner = (
                      <span style={{ color }}>
                        {sign}
                        {formatMoney(Math.abs(r.net), r.currency)}{' '}
                        <span className="muted">({label})</span>
                      </span>
                    )
                  }
                  const hasSettlements = r.settlementCount > 0
                  const formattedRawNet = formatMoney(r.rawNet, r.currency)
                  const formattedSettled = formatMoney(r.settledAmount, r.currency)
                  const netTitle = hasSettlements
                    ? `Raw: ${formattedRawNet}, settled: ${formattedSettled}`
                    : undefined
                  const netCell = (
                    <span title={netTitle}>
                      {netInner}
                      {hasSettlements && (
                        <>
                          <br />
                          <span className="muted" style={{ fontSize: '0.75rem' }}>
                            (after {r.settlementCount} settlement
                            {r.settlementCount === 1 ? '' : 's'})
                          </span>
                        </>
                      )}
                    </span>
                  )
                  return (
                    <tr key={`${r.currency}-${r.ownershipType ?? 'legacy'}-${r.ownershipContactId ?? 'none'}`}>
                      <td>{r.currency}</td>
                      <td>
                        {r.ownershipType === 'contact'
                          ? r.contactName ?? 'Contact'
                          : r.ownershipType ?? 'legacy split'}
                      </td>
                      <td>{formatMoney(r.sumMy, r.currency)}</td>
                      <td>{formatMoney(r.sumPartner, r.currency)}</td>
                      <td>{netCell}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card reportsTableCard">
          <div className="reportsCardHeader">
            <div>
              <h2>Business expenses</h2>
              <p className="muted">Transactions marked business, grouped by currency.</p>
            </div>
          </div>
          <div className="tableWrap" aria-busy={loading}>
            <table className="table">
              <thead>
                <tr>
                  <th>Currency</th>
                  <th>Business amount</th>
                </tr>
              </thead>
              <tbody>
                {(business?.byCurrency.length ?? 0) === 0 && !loading && (
                  <tr>
                    <td colSpan={2} className="emptyStateCell">
                      <p className="emptyState">
                        No business-tagged amounts for these filters.
                      </p>
                    </td>
                  </tr>
                )}
                {business?.byCurrency.map((r) => (
                  <tr key={r.currency}>
                    <td>{r.currency}</td>
                    <td>{formatMoney(r.sumBusiness, r.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <section className="card reportsTableCard">
        <div className="reportsCardHeader">
          <div>
            <h2>Recent settlements</h2>
            <p className="muted">
              Manual records of money paid between you and a contact. Applied to the net partner balance above.
            </p>
          </div>
        </div>
        {settlementsErr && <span className="error">{settlementsErr}</span>}
        <div className="tableWrap">
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Contact</th>
                <th>Direction</th>
                <th>Amount</th>
                <th>Notes</th>
                <th aria-label="Actions"></th>
              </tr>
            </thead>
            <tbody>
              {recentSettlements.length === 0 && (
                <tr>
                  <td colSpan={6} className="emptyStateCell">
                    <p className="emptyState">
                      No settlements yet. Click "Record settlement" above when money changes hands.
                    </p>
                  </td>
                </tr>
              )}
              {recentSettlements.map((row) => (
                <tr key={row.id}>
                  <td>{row.settledDate}</td>
                  <td>{row.contactName ?? 'Unknown'}</td>
                  <td>
                    <Badge variant={directionBadgeVariant(row.direction)}>
                      {directionLabel(row.direction)}
                    </Badge>
                  </td>
                  <td>{formatMoney(Number(row.amount), row.currency)}</td>
                  <td
                    className="muted"
                    style={{
                      maxWidth: '14rem',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={row.notes ?? undefined}
                  >
                    {row.notes ?? ''}
                  </td>
                  <td>
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      onClick={() => void removeSettlement(row)}
                    >
                      <Trash2 aria-hidden="true" />
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>

    {dialogOpen && (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) {
            setDialogOpen(false)
            setFormError(null)
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Record settlement</DialogTitle>
        </DialogHeader>
        <form onSubmit={submitSettlement}>
          <DialogBody>
            <div className="formGrid" style={{ display: 'grid', gap: '0.75rem' }}>
              <Label htmlFor="settlement-contact">
                Contact
                <NativeSelect
                  id="settlement-contact"
                  value={formContactId}
                  onChange={(e) => setFormContactId(e.target.value)}
                  required
                >
                  {contacts.length === 0 && (
                    <NativeSelectOption value="">
                      No contacts available
                    </NativeSelectOption>
                  )}
                  {contacts.map((c) => (
                    <NativeSelectOption key={c.id} value={String(c.id)}>
                      {c.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Label>
              <Label htmlFor="settlement-direction">
                Direction
                <NativeSelect
                  id="settlement-direction"
                  value={formDirection}
                  onChange={(e) =>
                    setFormDirection(
                      e.target.value as PartnerSettlementDirection
                    )
                  }
                >
                  <NativeSelectOption value="i_paid_partner">
                    I paid partner
                  </NativeSelectOption>
                  <NativeSelectOption value="partner_paid_me">
                    Partner paid me
                  </NativeSelectOption>
                </NativeSelect>
              </Label>
              <Label htmlFor="settlement-currency">
                Currency
                <NativeSelect
                  id="settlement-currency"
                  value={formCurrency}
                  onChange={(e) => setFormCurrency(e.target.value)}
                >
                  {availableCurrencies.map((c) => (
                    <NativeSelectOption key={c} value={c}>
                      {c}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Label>
              <Label htmlFor="settlement-amount">
                Amount
                <Input
                  id="settlement-amount"
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0.01"
                  value={formAmount}
                  onChange={(e) => setFormAmount(e.target.value)}
                  required
                />
              </Label>
              <Label htmlFor="settlement-date">
                Date
                <Input
                  id="settlement-date"
                  type="date"
                  value={formDate}
                  onChange={(e) => setFormDate(e.target.value)}
                  required
                />
              </Label>
              <Label htmlFor="settlement-notes">
                Notes
                <textarea
                  id="settlement-notes"
                  rows={3}
                  value={formNotes}
                  onChange={(e) => setFormNotes(e.target.value)}
                  className="min-h-9 w-full rounded-md border border-input bg-background/70 px-3 py-1 text-sm shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                />
              </Label>
              {formError && <span className="error">{formError}</span>}
            </div>
          </DialogBody>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={formSubmitting}>
              {formSubmitting ? 'Saving...' : 'Save settlement'}
            </Button>
          </DialogFooter>
        </form>
      </Dialog>
    )}
    {confirm.dialog}
    </>
  )
}
