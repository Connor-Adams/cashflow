import { useCallback, useEffect, useState } from 'react'
import { getJson, patchJson, postJson } from '../lib/api'
import type { Paginated, Transaction } from '../types/api'

export function TransactionsPage() {
  const [page, setPage] = useState(1)
  const [reviewOnly, setReviewOnly] = useState(false)
  const [currency, setCurrency] = useState('')
  const [res, setRes] = useState<Paginated<Transaction> | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const qs = new URLSearchParams({
        page: String(page),
        pageSize: '25',
      })
      if (reviewOnly) qs.set('reviewFlag', 'true')
      if (currency) qs.set('currency', currency)
      const data = await getJson<Paginated<Transaction>>(
        `/api/transactions?${qs.toString()}`
      )
      setRes(data)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Error')
    } finally {
      setLoading(false)
    }
  }, [page, reviewOnly, currency])

  useEffect(() => {
    void load()
  }, [load])

  async function saveRow(id: number, patch: Record<string, unknown>) {
    await patchJson<Transaction>(`/api/transactions/${id}`, patch)
    await load()
  }

  return (
    <div className="page">
      <h1>Transactions</h1>
      <div className="row">
        <label>
          <input
            type="checkbox"
            checked={reviewOnly}
            onChange={(e) => {
              setPage(1)
              setReviewOnly(e.target.checked)
            }}
          />{' '}
          Review only
        </label>
        <label>
          Currency{' '}
          <input
            value={currency}
            onChange={(e) => {
              setPage(1)
              setCurrency(e.target.value.toUpperCase())
            }}
            placeholder="e.g. USD"
            maxLength={3}
            style={{ width: 80 }}
          />
        </label>
        <button type="button" onClick={() => void load()} disabled={loading}>
          Refresh
        </button>
        <button
          type="button"
          onClick={async () => {
            try {
              setErr(null)
              await postJson<unknown>('/api/import/run', {})
              await load()
            } catch (e) {
              setErr(e instanceof Error ? e.message : 'Import failed')
            }
          }}
        >
          Run import
        </button>
      </div>
      {err && <span className="error">{err}</span>}
      <div className="tableWrap">
        <table className="table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Merchant</th>
              <th>Amount</th>
              <th>Cur</th>
              <th>Category</th>
              <th>Business</th>
              <th>Split</th>
              <th>% me</th>
              <th>% ptn</th>
              <th>Review</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {res?.data.map((t) => (
              <TransactionRow key={t.id} t={t} onSave={saveRow} />
            ))}
          </tbody>
        </table>
      </div>
      <div className="row">
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => setPage((p) => Math.max(1, p - 1))}
        >
          Prev
        </button>
        <span>
          Page {page} / {res ? Math.max(1, Math.ceil(res.total / res.pageSize)) : 1}
        </span>
        <button
          type="button"
          disabled={!res || page * res.pageSize >= res.total}
          onClick={() => setPage((p) => p + 1)}
        >
          Next
        </button>
      </div>
    </div>
  )
}

function TransactionRow({
  t,
  onSave,
}: {
  t: Transaction
  onSave: (id: number, patch: Record<string, unknown>) => Promise<void>
}) {
  const [cat, setCat] = useState(t.categoryOverride ?? '')
  const [biz, setBiz] = useState<string>(
    t.businessOverride === null || t.businessOverride === undefined
      ? ''
      : t.businessOverride
        ? 'true'
        : 'false'
  )
  const [split, setSplit] = useState(t.splitOverride ?? '')
  const [pctMe, setPctMe] = useState(
    t.pctMeOverride != null ? String(t.pctMeOverride) : ''
  )
  const [pctPartner, setPctPartner] = useState(
    t.pctPartnerOverride != null ? String(t.pctPartnerOverride) : ''
  )

  useEffect(() => {
    setCat(t.categoryOverride ?? '')
    setBiz(
      t.businessOverride === null || t.businessOverride === undefined
        ? ''
        : t.businessOverride
          ? 'true'
          : 'false'
    )
    setSplit(t.splitOverride ?? '')
    setPctMe(t.pctMeOverride != null ? String(t.pctMeOverride) : '')
    setPctPartner(
      t.pctPartnerOverride != null ? String(t.pctPartnerOverride) : ''
    )
  }, [t])

  return (
    <tr>
      <td>{t.date}</td>
      <td title={t.merchantRaw}>{t.merchantClean}</td>
      <td>{t.amount}</td>
      <td>{t.currency}</td>
      <td>
        <input
          value={cat}
          onChange={(e) => setCat(e.target.value)}
          placeholder={t.finalCategory ?? ''}
        />
      </td>
      <td>
        <select
          value={biz}
          onChange={(e) => setBiz(e.target.value)}
        >
          <option value="">(auto)</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      </td>
      <td>
        <select value={split} onChange={(e) => setSplit(e.target.value)}>
          <option value="">(auto)</option>
          <option value="me">me</option>
          <option value="partner">partner</option>
          <option value="shared">shared</option>
        </select>
      </td>
      <td>
        <input
          value={pctMe}
          onChange={(e) => setPctMe(e.target.value)}
          style={{ width: 56 }}
          placeholder="0.5"
        />
      </td>
      <td>
        <input
          value={pctPartner}
          onChange={(e) => setPctPartner(e.target.value)}
          style={{ width: 56 }}
          placeholder="0.5"
        />
      </td>
      <td>{t.reviewFlag ? 'yes' : ''}</td>
      <td>
        <button
          type="button"
          onClick={() =>
            void onSave(t.id, {
              categoryOverride: cat || null,
              businessOverride:
                biz === '' ? null : biz === 'true',
              splitOverride: split || null,
              pctMeOverride: pctMe === '' ? null : Number(pctMe),
              pctPartnerOverride:
                pctPartner === '' ? null : Number(pctPartner),
              reviewFlag: false,
            })
          }
        >
          Save
        </button>
      </td>
    </tr>
  )
}
