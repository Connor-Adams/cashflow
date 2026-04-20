import { useEffect, useMemo, useState } from 'react'
import { formatMoney } from '../lib/formatMoney'
import { summaryQueryString } from '../lib/summaryQuery'
import { getJson } from '../lib/api'

type PartnerRow = {
  currency: string
  sumMy: number
  sumPartner: number
}

type BusRow = { currency: string; sumBusiness: number }

export function ReportsPage() {
  const [currency, setCurrency] = useState('CAD')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
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

  return (
    <div className="page">
      <h1>Reports</h1>
      <p className="muted">
        Partner balances and business totals are reported per currency.
      </p>
      <div className="row">
        <label>
          Filter currency{' '}
          <input
            value={currency}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            maxLength={3}
            placeholder="CAD"
            style={{ width: 80 }}
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
      </div>
      {err && <span className="error">{err}</span>}
      {loading && <p className="muted">Loading…</p>}

      <h2>Partner split totals</h2>
      <div className="tableWrap" aria-busy={loading}>
        <table className="table">
          <thead>
            <tr>
              <th>Currency</th>
              <th>My share</th>
              <th>Partner share</th>
            </tr>
          </thead>
          <tbody>
            {!loading &&
              (partner?.byCurrency.length ?? 0) === 0 && (
                <tr>
                  <td colSpan={3} className="emptyStateCell">
                    <p className="emptyState">
                      No partner-split data for these filters. Import transactions
                      or widen the date range.
                    </p>
                  </td>
                </tr>
              )}
            {!loading &&
              partner?.byCurrency.map((r) => (
                <tr key={r.currency}>
                  <td>{r.currency}</td>
                  <td>{formatMoney(r.sumMy, r.currency)}</td>
                  <td>{formatMoney(r.sumPartner, r.currency)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <h2>Business expenses</h2>
      <div className="tableWrap" aria-busy={loading}>
        <table className="table">
          <thead>
            <tr>
              <th>Currency</th>
              <th>Business amount</th>
            </tr>
          </thead>
          <tbody>
            {!loading &&
              (business?.byCurrency.length ?? 0) === 0 && (
                <tr>
                  <td colSpan={2} className="emptyStateCell">
                    <p className="emptyState">
                      No business-tagged amounts for these filters.
                    </p>
                  </td>
                </tr>
              )}
            {!loading &&
              business?.byCurrency.map((r) => (
                <tr key={r.currency}>
                  <td>{r.currency}</td>
                  <td>{formatMoney(r.sumBusiness, r.currency)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
