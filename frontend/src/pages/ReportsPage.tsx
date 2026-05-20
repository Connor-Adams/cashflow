import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { FilterBar, type QuickRange } from '@/components/ui/filter-bar'
import { PageHeader } from '@/components/ui/page-header'
import { toDateInputValue } from '../lib/dateInput'
import { formatMoney } from '../lib/formatMoney'
import { summaryQueryString } from '../lib/summaryQuery'
import { getJson } from '../lib/api'
import { useSessionState } from '../lib/useSessionState'

type PartnerNetDirection = 'partner_owes_me' | 'i_owe_partner' | 'even'

type PartnerRow = {
  currency: string
  ownershipType?: string
  ownershipContactId?: number | null
  contactName?: string | null
  sumMy: number
  sumPartner: number
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

  return (
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
                  let netCell
                  if (r.direction === 'even') {
                    netCell = <span className="muted">Even</span>
                  } else {
                    const partnerOwesMe = r.direction === 'partner_owes_me'
                    const color = partnerOwesMe ? 'var(--accent-green)' : 'var(--danger)'
                    const sign = partnerOwesMe ? '+' : '−'
                    const label = partnerOwesMe ? 'partner owes you' : 'you owe partner'
                    netCell = (
                      <span style={{ color }}>
                        {sign}
                        {formatMoney(Math.abs(r.net), r.currency)}{' '}
                        <span className="muted">({label})</span>
                      </span>
                    )
                  }
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
    </div>
  )
}
