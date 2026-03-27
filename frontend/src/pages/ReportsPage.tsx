import { useEffect, useState } from 'react'
import { getJson } from '../lib/api'

type PartnerRow = {
  currency: string
  sumMy: number
  sumPartner: number
}

type BusRow = { currency: string; sumBusiness: number }

export function ReportsPage() {
  const [currency, setCurrency] = useState('')
  const [partner, setPartner] = useState<{ byCurrency: PartnerRow[] } | null>(
    null
  )
  const [business, setBusiness] = useState<{ byCurrency: BusRow[] } | null>(
    null
  )
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const q = currency ? `?currency=${encodeURIComponent(currency)}` : ''
        const [p, b] = await Promise.all([
          getJson<{ byCurrency: PartnerRow[] }>(`/api/summary/partner${q}`),
          getJson<{ byCurrency: BusRow[] }>(`/api/summary/business${q}`),
        ])
        if (!cancelled) {
          setPartner(p)
          setBusiness(b)
        }
      } catch (e) {
        if (!cancelled)
          setErr(e instanceof Error ? e.message : 'Error')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [currency])

  return (
    <div className="page">
      <h1>Reports</h1>
      <p className="muted">
        Partner balances and business totals are reported per currency.
      </p>
      <label>
        Filter currency{' '}
        <input
          value={currency}
          onChange={(e) => setCurrency(e.target.value.toUpperCase())}
          maxLength={3}
          placeholder="optional"
          style={{ width: 80 }}
        />
      </label>
      {err && <span className="error">{err}</span>}

      <h2>Partner split totals</h2>
      <div className="tableWrap">
        <table className="table">
          <thead>
            <tr>
              <th>Currency</th>
              <th>My share</th>
              <th>Partner share</th>
            </tr>
          </thead>
          <tbody>
            {partner?.byCurrency.map((r) => (
              <tr key={r.currency}>
                <td>{r.currency}</td>
                <td>{r.sumMy}</td>
                <td>{r.sumPartner}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Business expenses</h2>
      <div className="tableWrap">
        <table className="table">
          <thead>
            <tr>
              <th>Currency</th>
              <th>Business amount</th>
            </tr>
          </thead>
          <tbody>
            {business?.byCurrency.map((r) => (
              <tr key={r.currency}>
                <td>{r.currency}</td>
                <td>{r.sumBusiness}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
