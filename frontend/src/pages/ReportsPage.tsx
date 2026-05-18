import { useEffect, useMemo, useState } from 'react'
import { PageHeader } from '@/components/ui/page-header'
import { toDateInputValue } from '../lib/dateInput'
import { formatMoney } from '../lib/formatMoney'
import { summaryQueryString } from '../lib/summaryQuery'
import { getJson } from '../lib/api'
import { useSessionState } from '../lib/useSessionState'

type PartnerRow = {
  currency: string
  ownershipType?: string
  ownershipContactId?: number | null
  contactName?: string | null
  sumMy: number
  sumPartner: number
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
  const quickRanges = useMemo(
    () => [
      { key: '30d', label: '30 days', ...getRelativeDateRange(30) },
      { key: '90d', label: '90 days', ...getRelativeDateRange(90) },
      { key: 'ytd', label: 'YTD', ...getYearToDateRange() },
      { key: 'all', label: 'All time', from: '', to: '' },
    ],
    []
  )
  const activeQuickRange = useMemo(
    () =>
      quickRanges.find((range) => range.from === dateFrom && range.to === dateTo)?.key ??
      null,
    [quickRanges, dateFrom, dateTo]
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
        <div className="row">
          <label>
            Currency{' '}
            <input
              value={currency}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              maxLength={3}
              placeholder="CAD"
              style={{ width: 90 }}
            />
          </label>
          <label>
            From{' '}
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
            />
          </label>
          <label>
            To{' '}
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
            />
          </label>
          {hasActiveFilters && (
            <button
              type="button"
              onClick={() => {
                setCurrency(DEFAULT_REPORTS_CURRENCY)
                setDateFrom('')
                setDateTo('')
              }}
            >
              Clear filters
            </button>
          )}
        </div>
        <div className="quickFilters" aria-label="Quick report date ranges">
          {quickRanges.map((range) => (
            <button
              key={range.key}
              type="button"
              className="quickFilterButton"
              aria-pressed={activeQuickRange === range.key}
              onClick={() => {
                setDateFrom(range.from)
                setDateTo(range.to)
              }}
            >
              {range.label}
            </button>
          ))}
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          Showing <strong>{currency || 'all currencies'}</strong> for{' '}
          <strong>{activeRangeLabel}</strong>.
        </p>
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
          <div className="tableWrap" aria-busy={loading}>
            <table className="table">
              <thead>
                <tr>
                  <th>Currency</th>
                  <th>Ownership</th>
                  <th>My share</th>
                  <th>Partner share</th>
                </tr>
              </thead>
              <tbody>
                {(partner?.byCurrency.length ?? 0) === 0 && !loading && (
                  <tr>
                    <td colSpan={4} className="emptyStateCell">
                      <p className="emptyState">
                        No partner-split data for these filters. Import transactions or widen the date range.
                      </p>
                    </td>
                  </tr>
                )}
                {partner?.byCurrency.map((r) => (
                  <tr key={`${r.currency}-${r.ownershipType ?? 'legacy'}-${r.ownershipContactId ?? 'none'}`}>
                    <td>{r.currency}</td>
                    <td>
                      {r.ownershipType === 'contact'
                        ? r.contactName ?? 'Contact'
                        : r.ownershipType ?? 'legacy split'}
                    </td>
                    <td>{formatMoney(r.sumMy, r.currency)}</td>
                    <td>{formatMoney(r.sumPartner, r.currency)}</td>
                  </tr>
                ))}
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
