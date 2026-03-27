import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { getJson, postJson } from '../lib/api'
import type { Account } from '../types/api'

export function AccountsPage() {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setErr(null)
    try {
      setAccounts(await getJson<Account[]>('/api/accounts'))
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load accounts')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function onCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    const name = String(fd.get('name') ?? '').trim()
    if (!name) {
      setErr('Name is required')
      return
    }
    setSaving(true)
    setErr(null)
    try {
      await postJson<Account>('/api/accounts', {
        name,
        owner: String(fd.get('owner') ?? 'me'),
        shortCode: String(fd.get('shortCode') ?? '').trim() || null,
        defaultCurrency:
          String(fd.get('defaultCurrency') ?? '').trim().toUpperCase() ||
          null,
      })
      e.currentTarget.reset()
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not create account')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="page">
      <h1>Accounts</h1>
      <p className="muted">
        Each account is a card or bank account. Use a short code (e.g.{' '}
        <code>Amex</code>) so folder imports can match{' '}
        <code>Amex_2025_01.csv</code>.
      </p>

      <form className="card" onSubmit={onCreate}>
        <h2>New account</h2>
        <div className="formGrid">
          <label>
            Name <span className="req">*</span>
            <input name="name" required placeholder="Amex Personal" />
          </label>
          <label>
            Owner
            <select name="owner" defaultValue="me">
              <option value="me">me</option>
              <option value="partner">partner</option>
              <option value="joint">joint</option>
            </select>
          </label>
          <label>
            Short code
            <input
              name="shortCode"
              placeholder="Amex"
              maxLength={64}
              autoCapitalize="off"
            />
          </label>
          <label>
            Default currency
            <input
              name="defaultCurrency"
              placeholder="USD"
              maxLength={3}
              style={{ width: 80 }}
            />
          </label>
        </div>
        <button type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Create account'}
        </button>
      </form>

      {err && <p className="error">{err}</p>}

      <h2>Your accounts</h2>
      {loading ? (
        <p className="muted">Loading…</p>
      ) : (
        <div className="tableWrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Owner</th>
                <th>Short code</th>
                <th>Default currency</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id}>
                  <td>{a.name}</td>
                  <td>{a.owner}</td>
                  <td>{a.shortCode ?? '—'}</td>
                  <td>{a.defaultCurrency ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {accounts.length === 0 && !loading && (
            <p className="muted pad">No accounts yet — create one above.</p>
          )}
        </div>
      )}
    </div>
  )
}
