import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Download, Plus, Trash2 } from 'lucide-react'
import { Alert } from '@connor-adams/designsystem'
import { EmptyState } from '@connor-adams/designsystem'
import { EmptyTableRow } from '@/lib/ds-extras'
import { Badge } from '@connor-adams/designsystem'
import { Button } from '@connor-adams/designsystem'
import { Grid } from '@/lib/ds-extras'
import { StatCard } from '@/components/ui/stat-card'
import { CollapsibleCard } from '@/components/ui/collapsible-card'
import { Dialog } from '@connor-adams/designsystem'
import { useConfirm } from '@/lib/ds-extras'
import { FilterBar, type QuickRange } from '@/components/ui/filter-bar'
import { Input } from '@connor-adams/designsystem'
import { Label } from '@connor-adams/designsystem'
import { Textarea } from '@connor-adams/designsystem'
import { NativeSelect } from '@connor-adams/designsystem'
import { PageHeader } from '@/components/ui/page-header'
import { Skeleton } from '@connor-adams/designsystem'
import { SkeletonRow } from '@/lib/ds-extras'
import { Card } from '@connor-adams/designsystem'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@connor-adams/designsystem'
import { useToast } from '@/components/ui/toast'
import { cn } from '@/lib/utils'
import { buildCsv, downloadCsv } from '../lib/csv'
import {
  fromDateInputValue,
  getRelativeDateRange,
  toDateInputValue,
  todayDateInputValue,
} from '../lib/dateInput'
import { formatMoney } from '../lib/formatMoney'
import { summaryQueryString } from '../lib/summaryQuery'
import { deleteReq, getJson, postJson } from '../lib/api'
import { rankByNetSpend } from '../lib/rankByNetSpend'
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

// Merchant + account rollups consumed for the comprehensive
// merchant/account tables linked from the Dashboard bento "View all".
// Types mirror what /api/summary/dashboard returns; DashboardPage defines
// them inline today — extract to types/api.ts in a follow-up sweep.
type MerchantSummaryRow = {
  currency: string
  merchant: string
  totalSpend: number
  totalCredits: number
  totalPayments: number
  netSpend: number
  transactionCount: number
  lastDate: string
  reviewCount: number
}

type AccountSummaryRow = {
  currency: string
  accountId: number
  accountName: string
  accountShortCode: string | null
  totalSpend: number
  totalCredits: number
  totalPayments: number
  netSpend: number
  transactionCount: number
  reviewCount: number
}

type DashboardSummarySubset = {
  merchantSummaries: MerchantSummaryRow[]
  accountSummaries: AccountSummaryRow[]
}

const DEFAULT_REPORTS_CURRENCY = 'CAD'

/**
 * Anchor for default-range calculations: UTC midnight of the user's local
 * calendar day. Keeps the derived YYYY-MM-DD strings stable across timezones
 * (issue #280).
 */
function localTodayUtcMidnight(): Date {
  return fromDateInputValue(todayDateInputValue())!
}

function getYearToDateRange(): { from: string; to: string } {
  const to = localTodayUtcMidnight()
  const from = new Date(Date.UTC(to.getUTCFullYear(), 0, 1))
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
  const [merchantSummaries, setMerchantSummaries] = useState<MerchantSummaryRow[]>(
    []
  )
  const [accountSummaries, setAccountSummaries] = useState<AccountSummaryRow[]>(
    []
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
  const [formAmountError, setFormAmountError] = useState<string | null>(null)
  const [formDateError, setFormDateError] = useState<string | null>(null)
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
        const [p, b, dash] = await Promise.all([
          getJson<{ byCurrency: PartnerRow[] }>(
            `/api/summary/partner${summaryQs}`
          ),
          getJson<{ byCurrency: BusRow[] }>(
            `/api/summary/business${summaryQs}`
          ),
          getJson<DashboardSummarySubset>(
            `/api/summary/dashboard${summaryQs}`
          ),
        ])
        if (!cancelled) {
          setPartner(p)
          setBusiness(b)
          setMerchantSummaries(dash.merchantSummaries ?? [])
          setAccountSummaries(dash.accountSummaries ?? [])
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

  // Merchant/account rollups filtered to the active currency (if set) and
  // sorted by net spend desc. Drives the comprehensive tables linked from
  // the Dashboard bento "View all" → /reports#merchants and #accounts.
  const filteredMerchantSummaries = useMemo(
    () => rankByNetSpend(merchantSummaries, currency),
    [merchantSummaries, currency]
  )

  const filteredAccountSummaries = useMemo(
    () => rankByNetSpend(accountSummaries, currency),
    [accountSummaries, currency]
  )

  // Hash-anchor scroll on mount + on hash change. React Router does not
  // scroll-into-view on hash navigation by default, so handle it here.
  useEffect(() => {
    const id = window.location.hash.replace(/^#/, '')
    if (!id) return
    // Wait one tick so the section has rendered before scrolling.
    const timer = window.setTimeout(() => {
      document.getElementById(id)?.scrollIntoView({ block: 'start' })
    }, 0)
    return () => window.clearTimeout(timer)
  }, [])

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
    setFormAmountError(null)
    setFormDateError(null)
    setFormContactId(contacts.length > 0 ? String(contacts[0].id) : '')
    setFormDirection('i_paid_partner')
    setFormCurrency(currency || DEFAULT_REPORTS_CURRENCY)
    setFormAmount('')
    setFormDate(todayDateInputValue())
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

  // Filter the visible rows once so the CSV mirrors exactly what the
  // user sees on screen.
  const visiblePartnerRows = useMemo(
     () => (partner?.byCurrency ?? []).filter((r) => !currency || r.currency === currency),
    [partner, currency]
  )
  const visibleBusinessRows = useMemo(
    () => (business?.byCurrency ?? []).filter((r) => !currency || r.currency === currency),
    [business, currency]
  )
  const partnerExportDisabled = visiblePartnerRows.length === 0
  const businessExportDisabled = visibleBusinessRows.length === 0

  // Page-level empty state (#799): every report dataset is empty AND no filter
  // is narrowing the view, so the account genuinely has no spend to report.
  // When a filter is active we fall through to the per-table empty rows, which
  // already say "no activity for these filters".
  const hasNoSpendData =
    !loading &&
    !err &&
    !hasActiveFilters &&
    (partner?.byCurrency.length ?? 0) === 0 &&
    (business?.byCurrency.length ?? 0) === 0 &&
    merchantSummaries.length === 0 &&
    accountSummaries.length === 0

  // Build a "{from}-to-{to}" stub for the filename. Falls back to "all-dates"
  // and uses today's date as a leg when only one bound is set, so filenames
  // still sort sensibly on disk. Uses todayDateInputValue so the leg reflects
  // the user's local calendar day, not a TZ-shifted UTC day.
  const exportDateStub = useMemo(() => {
    if (!dateFrom && !dateTo) return 'all-dates'
    const today = todayDateInputValue()
    return `${dateFrom || 'earliest'}-to-${dateTo || today}`
  }, [dateFrom, dateTo])
  const currencyStub = currency ? currency.toLowerCase() : 'all'

  const partnerDirectionLabel = (dir: PartnerNetDirection) => {
    if (dir === 'partner_owes_me') return 'partner owes me'
    if (dir === 'i_owe_partner') return 'i owe partner'
    return 'even'
  }

  function exportPartnerCsv() {
    if (partnerExportDisabled) return
    const headers = [
      'Currency',
      'Ownership',
      'My share',
      'Partner share',
      'Net',
      'Direction',
      'Settlements applied',
      'Settled amount',
      'Raw net',
    ] as const
    const rows = visiblePartnerRows.map((r) => {
      const ownership =
        r.ownershipType === 'contact'
          ? r.contactName ?? 'Contact'
          : r.ownershipType ?? 'legacy split'
      return [
        r.currency,
        ownership,
        r.sumMy,
        r.sumPartner,
        r.net,
        partnerDirectionLabel(r.direction),
        r.settlementCount,
        r.settledAmount,
        r.rawNet,
      ]
    })
    const csv = buildCsv(headers, rows)
    const filename = `cashflow-partner-${currencyStub}-${exportDateStub}.csv`
    downloadCsv(filename, csv)
  }

  function exportBusinessCsv() {
    if (businessExportDisabled) return
    const headers = ['Currency', 'Business amount'] as const
    const rows = visibleBusinessRows.map((r) => [r.currency, r.sumBusiness])
    const csv = buildCsv(headers, rows)
    const filename = `cashflow-business-${currencyStub}-${exportDateStub}.csv`
    downloadCsv(filename, csv)
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

  if (hasNoSpendData) {
    return (
      <div className="page">
        <PageHeader
          title="Reports"
          description="Partner balances and business totals stay separated by currency and time window."
        />
        <EmptyState
          title="No spend to report yet"
          description="Import some transactions and your monthly summary will appear here."
          actions={
            <Link to="/import">
              <Button size="sm">Import a statement</Button>
            </Link>
          }
        />
      </div>
    )
  }

  return (
    <>
    <div className="page">
      <PageHeader
        title="Reports"
        description="Partner balances and business totals stay separated by currency and time window."
      />
      <Card className="mb-4">
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
            <p className="mb-0 text-sm leading-6 text-muted-foreground">
              Showing <strong>{currency || 'all currencies'}</strong> for{' '}
              <strong>{activeRangeLabel}</strong>.
            </p>
          }
        />
      </Card>
      {err && <Alert variant="error" className="mb-4">{err}</Alert>}

      {loading ? (
        <Grid minItemWidth={180} gap="md" responsiveFloor={false} className="mb-4" aria-busy={loading}>
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={`reports-skeleton-${i}`} className="mb-0">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="mt-2 h-7 w-28" />
              <Skeleton className="mt-2 h-3 w-24" />
            </Card>
          ))}
        </Grid>
      ) : (
      <Grid minItemWidth={180} gap="md" responsiveFloor={false} className="mb-4" aria-busy={loading}>
        <StatCard
          label="My share"
          value={singleCurrency ? formatMoney(partnerMineTotal, singleCurrency) : `${reportCurrencies.length} currencies`}
          hint={moneySummaryHint}
        />
        <StatCard
          label="Partner share"
          value={singleCurrency
            ? formatMoney(partnerShareTotal, singleCurrency)
            : `${reportCurrencies.length} currencies`}
          hint={moneySummaryHint}
        />
        <StatCard
          label="Business total"
          value={singleCurrency ? formatMoney(businessTotal, singleCurrency) : `${reportCurrencies.length} currencies`}
          hint={moneySummaryHint}
        />
        <StatCard
          label="Currencies"
          value={reportCurrencies.length}
          hint={`${totalPartnerRows} partner row${totalPartnerRows === 1 ? '' : 's'} and ${totalBusinessRows} business row${totalBusinessRows === 1 ? '' : 's'}`}
        />
      </Grid>
      )}

      <Grid minItemWidth={320} gap="lg">
        <CollapsibleCard
          id="partner-split"
          className="mb-0"
          title="Partner split totals"
          description="How much of the selected spend belongs to each person."
          actions={
            <>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={exportPartnerCsv}
                disabled={partnerExportDisabled}
                title={
                  partnerExportDisabled
                    ? 'No partner rows to export'
                    : 'Download the partner split table as CSV'
                }
              >
                <Download aria-hidden="true" />
                Export CSV
              </Button>
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
            </>
          }
        >
          {showPartnerRollup && (
            <ul className="list-none p-0 mb-3 flex flex-col gap-1">
              {partnerNetByCurrency.map(([cur, total]) => {
                const rounded = Math.round(total * 100) / 100
                if (rounded === 0) {
                  return (
                    <li key={cur} className="text-sm leading-6 text-muted-foreground mb-0">
                      <strong>{cur}</strong>: even
                    </li>
                  )
                }
                const partnerOwesMe = rounded > 0
                const label = partnerOwesMe ? 'partner owes you' : 'you owe partner'
                return (
                  <li key={cur} className="text-sm">
                    <strong>{cur}</strong>:{' '}
                    <span className={cn('font-semibold', partnerOwesMe ? 'text-positive' : 'text-danger')}>
                      {formatMoney(Math.abs(rounded), cur)}
                    </span>{' '}
                    <span className="text-sm leading-6 text-muted-foreground mb-0">({label})</span>
                  </li>
                )
              })}
            </ul>
          )}
          <Table aria-busy={loading}>
              <TableHeader>
                <TableRow>
                  <TableHead>Currency</TableHead>
                  <TableHead>Ownership</TableHead>
                  <TableHead>My share</TableHead>
                  <TableHead>Partner share</TableHead>
                  <TableHead>Net</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading &&
                  Array.from({ length: 6 }).map((_, i) => (
                    <SkeletonRow key={`reports-skeleton-${i}`} cols={5} />
                  ))}
                {(partner?.byCurrency.length ?? 0) === 0 && !loading && (
                  <EmptyTableRow
                    colSpan={5}
                    title="No partner-split data for these filters. Import transactions or widen the date range."
                  />
                )}
                {partner?.byCurrency.map((r) => {
                  let netInner
                  if (r.direction === 'even') {
                    netInner = <span className="text-sm leading-6 text-muted-foreground mb-0">Even</span>
                  } else {
                    const partnerOwesMe = r.direction === 'partner_owes_me'
                    const sign = partnerOwesMe ? '+' : '−'
                    const label = partnerOwesMe ? 'partner owes you' : 'you owe partner'
                    netInner = (
                      <span className={partnerOwesMe ? 'text-positive' : 'text-danger'}>
                        {sign}
                        {formatMoney(Math.abs(r.net), r.currency)}{' '}
                        <span className="text-sm leading-6 text-muted-foreground mb-0">({label})</span>
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
                          <span className="text-xs text-muted-foreground mb-0">
                            (after {r.settlementCount} settlement
                            {r.settlementCount === 1 ? '' : 's'})
                          </span>
                        </>
                      )}
                    </span>
                  )
                  return (
                    <TableRow key={`${r.currency}-${r.ownershipType ?? 'legacy'}-${r.ownershipContactId ?? 'none'}`}>
                      <TableCell>{r.currency}</TableCell>
                      <TableCell>
                        {r.ownershipType === 'contact'
                          ? r.contactName ?? 'Contact'
                          : r.ownershipType ?? 'legacy split'}
                      </TableCell>
                      <TableCell>{formatMoney(r.sumMy, r.currency)}</TableCell>
                      <TableCell>{formatMoney(r.sumPartner, r.currency)}</TableCell>
                      <TableCell>{netCell}</TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
        </CollapsibleCard>

        <CollapsibleCard
          id="business-expenses"
          className="mb-0"
          title="Business expenses"
          description="Transactions marked business, grouped by currency."
          actions={
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={exportBusinessCsv}
              disabled={businessExportDisabled}
              title={
                businessExportDisabled
                  ? 'No business rows to export'
                  : 'Download the business totals table as CSV'
              }
            >
              <Download aria-hidden="true" />
              Export CSV
            </Button>
          }
        >
          <Table aria-busy={loading}>
              <TableHeader>
                <TableRow>
                  <TableHead>Currency</TableHead>
                  <TableHead>Business amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading &&
                  Array.from({ length: 6 }).map((_, i) => (
                    <SkeletonRow key={`reports-skeleton-${i}`} cols={2} />
                  ))}
                {(business?.byCurrency.length ?? 0) === 0 && !loading && (
                  <EmptyTableRow
                    colSpan={2}
                    title="No business-tagged amounts for these filters."
                  />
                )}
                {business?.byCurrency.map((r) => (
                  <TableRow key={r.currency}>
                    <TableCell>{r.currency}</TableCell>
                    <TableCell>{formatMoney(r.sumBusiness, r.currency)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
        </CollapsibleCard>
      </Grid>

      <CollapsibleCard
        id="settlements"
        className="mb-0"
        title="Recent settlements"
        description="Manual records of money paid between you and a contact. Applied to the net partner balance above."
      >
        {settlementsErr && <Alert variant="error" className="mb-4">{settlementsErr}</Alert>}
        <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Contact</TableHead>
                <TableHead>Direction</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Notes</TableHead>
                <TableHead aria-label="Actions"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recentSettlements.length === 0 && (
                <EmptyTableRow
                  colSpan={6}
                  title='No settlements yet. Click "Record settlement" above when money changes hands.'
                />
              )}
              {recentSettlements.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>{row.settledDate}</TableCell>
                  <TableCell>{row.contactName ?? 'Unknown'}</TableCell>
                  <TableCell>
                    <Badge variant={directionBadgeVariant(row.direction)}>
                      {directionLabel(row.direction)}
                    </Badge>
                  </TableCell>
                  <TableCell>{formatMoney(Number(row.amount), row.currency)}</TableCell>
                  <TableCell
                    className="text-sm leading-6 text-muted-foreground mb-0 max-w-[14rem] overflow-hidden text-ellipsis whitespace-nowrap"
                    title={row.notes ?? undefined}
                  >
                    {row.notes ?? ''}
                  </TableCell>
                  <TableCell>
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      onClick={() => void removeSettlement(row)}
                    >
                      <Trash2 aria-hidden="true" />
                      Delete
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
      </CollapsibleCard>

      <RankedReportSection
        id="merchants"
        title="Merchants"
        description={
          <>
            All merchants in this view, ranked by net spend. Linked from
            the Dashboard's <em>Top merchants</em> tile.
          </>
        }
        headers={[
          'Merchant',
          'Txns',
          'Spend',
          'Refunds / credits',
          'Payments',
          'Net spend',
          'Needs review',
          'Last seen',
        ]}
        showCurrencyColumn={!currency}
        rows={filteredMerchantSummaries}
        rowKey={(r) => `${r.currency}:${r.merchant}`}
        renderRow={(r) => (
          <>
            {!currency && <td>{r.currency}</td>}
            <td>{r.merchant}</td>
            <td>{r.transactionCount}</td>
            <td>{formatMoney(r.totalSpend, r.currency)}</td>
            <td>{formatMoney(r.totalCredits, r.currency)}</td>
            <td>{formatMoney(r.totalPayments, r.currency)}</td>
            <td>{formatMoney(r.netSpend, r.currency)}</td>
            <td>{r.reviewCount}</td>
            <td>{r.lastDate}</td>
          </>
        )}
        emptyMessage="No merchant activity for these filters."
        loading={loading}
      />

      <RankedReportSection
        id="accounts"
        title="Accounts"
        description={
          <>
            All accounts in this view, ranked by net spend. Linked from
            the Dashboard's <em>Top accounts</em> tile.
          </>
        }
        headers={[
          'Account',
          'Txns',
          'Spend',
          'Refunds / credits',
          'Payments',
          'Net spend',
          'Needs review',
        ]}
        showCurrencyColumn={!currency}
        rows={filteredAccountSummaries}
        rowKey={(r) => `${r.currency}:${r.accountId}`}
        renderRow={(r) => (
          <>
            {!currency && <td>{r.currency}</td>}
            <td>{r.accountShortCode ?? r.accountName}</td>
            <td>{r.transactionCount}</td>
            <td>{formatMoney(r.totalSpend, r.currency)}</td>
            <td>{formatMoney(r.totalCredits, r.currency)}</td>
            <td>{formatMoney(r.totalPayments, r.currency)}</td>
            <td>{formatMoney(r.netSpend, r.currency)}</td>
            <td>{r.reviewCount}</td>
          </>
        )}
        emptyMessage="No account activity for these filters."
        loading={loading}
      />
    </div>

    {dialogOpen && (
      <Dialog
        open
        onClose={() => {
          setDialogOpen(false)
          setFormError(null)
        }}
        title={<>Record settlement</>}
      >
        <form onSubmit={submitSettlement}>
            <Grid minItemWidth={180} fill gap="md" className="mb-3">
              <Label htmlFor="settlement-contact">
                Contact
                <NativeSelect
                  id="settlement-contact"
                  value={formContactId}
                  onChange={(e) => setFormContactId(e.target.value)}
                  required
                >
                  {contacts.length === 0 && (
                    <option value="">
                      No contacts — add one in Settings
                    </option>
                  )}
                  {contacts.map((c) => (
                    <option key={c.id} value={String(c.id)}>
                      {c.name}
                    </option>
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
                  <option value="i_paid_partner">
                    I paid partner
                  </option>
                  <option value="partner_paid_me">
                    Partner paid me
                  </option>
                </NativeSelect>
              </Label>
              <Label htmlFor="settlement-currency">
                Currency
                <NativeSelect
                  id="settlement-currency"
                  value={formCurrency}
                  onChange={(e) => setFormCurrency(e.target.value)}
                >
                  {availableCurrencies.length === 0 && (
                    <option value="">
                      No currencies — add an account in Settings
                    </option>
                  )}
                  {availableCurrencies.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
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
                  onChange={(e) => {
                    setFormAmount(e.target.value)
                    const n = Number(e.target.value)
                    if (e.target.value !== '' && (!Number.isFinite(n) || n <= 0)) {
                      setFormAmountError('Enter a positive amount.')
                    } else {
                      setFormAmountError(null)
                    }
                  }}
                  onBlur={(e) => {
                    const n = Number(e.target.value)
                    if (!e.target.value || !Number.isFinite(n) || n <= 0) {
                      setFormAmountError('Enter a positive amount.')
                    }
                  }}
                  required
                  aria-describedby={formAmountError ? 'settlement-amount-err' : undefined}
                />
                {formAmountError && (
                  <span id="settlement-amount-err" className="text-danger text-xs" role="alert">
                    {formAmountError}
                  </span>
                )}
              </Label>
              <Label htmlFor="settlement-date">
                Date
                <Input
                  id="settlement-date"
                  type="date"
                  value={formDate}
                  onChange={(e) => {
                    setFormDate(e.target.value)
                    if (e.target.value) setFormDateError(null)
                  }}
                  onBlur={(e) => {
                    if (!e.target.value) setFormDateError('Date required.')
                  }}
                  required
                  aria-describedby={formDateError ? 'settlement-date-err' : undefined}
                />
                {formDateError && (
                  <span id="settlement-date-err" className="text-danger text-xs" role="alert">
                    {formDateError}
                  </span>
                )}
              </Label>
              <Label htmlFor="settlement-notes">
                Notes
                <Textarea
                  id="settlement-notes"
                  rows={3}
                  value={formNotes}
                  onChange={(e) => setFormNotes(e.target.value)}
                />
              </Label>
              {formError && <Alert variant="error" className="mb-4">{formError}</Alert>}
            </Grid>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={formSubmitting || Boolean(formAmountError) || Boolean(formDateError)}>
              {formSubmitting ? 'Saving...' : 'Save settlement'}
            </Button>
          </div>
        </form>
      </Dialog>
    )}
    {confirm.dialog}
    </>
  )
}

type RankedReportSectionProps<R> = {
  id: string
  title: string
  description: React.ReactNode
  /** When true, render a leading "Currency" header column. The row
   *  renderer is still responsible for emitting the matching <td>. */
  showCurrencyColumn: boolean
  /** Header labels for non-currency columns. */
  headers: string[]
  rows: R[]
  rowKey: (row: R) => string
  /** Returns the row's `<td>` cells (currency cell included when shown). */
  renderRow: (row: R) => React.ReactNode
  emptyMessage: string
  loading: boolean
}

/**
 * Shared chrome for the comprehensive ranking sections at the bottom of
 * the Reports page (Merchants, Accounts). Extracted to kill duplication
 * between two near-identical table layouts.
 */
function RankedReportSection<R>({
  id,
  title,
  description,
  showCurrencyColumn,
  headers,
  rows,
  rowKey,
  renderRow,
  emptyMessage,
  loading,
}: RankedReportSectionProps<R>) {
  const totalColumns = (showCurrencyColumn ? 1 : 0) + headers.length
  return (
    <CollapsibleCard
      id={id}
      title={title}
      description={description}
      toggleLabel={title}
    >
      <Table>
          <TableHeader>
            <TableRow>
              {showCurrencyColumn && <TableHead>Currency</TableHead>}
              {headers.map((h) => (
                <TableHead key={h}>{h}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {!loading && rows.length === 0 && (
              <EmptyTableRow colSpan={totalColumns} title={emptyMessage} />
            )}
            {rows.map((row) => (
              <TableRow key={rowKey(row)}>{renderRow(row)}</TableRow>
            ))}
          </TableBody>
        </Table>
    </CollapsibleCard>
  )
}
