import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { deleteReq, getJson, patchJson, postJson } from '../lib/api'
import type { Account } from '../types/api'

const CURRENCY_OPTIONS = ['CAD', 'USD', 'EUR', 'GBP'] as const

export function AccountsPage() {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editName, setEditName] = useState('')
  const [editOwner, setEditOwner] = useState<'me' | 'partner' | 'joint'>('me')
  const [editShortCode, setEditShortCode] = useState('')
  const [editCurrency, setEditCurrency] = useState('')
  const loadRequestRef = useRef(0)

  const load = useCallback(async () => {
    const requestId = ++loadRequestRef.current
    setLoading(true)
    setErr(null)
    try {
      const nextAccounts = await getJson<Account[]>('/api/accounts')
      if (loadRequestRef.current === requestId) {
        setAccounts(nextAccounts)
      }
    } catch (e) {
      if (loadRequestRef.current === requestId) {
        setErr(e instanceof Error ? e.message : 'Failed to load accounts')
      }
    } finally {
      if (loadRequestRef.current === requestId) {
        setLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function onCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = e.currentTarget
    const fd = new FormData(form)
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
          undefined,
      })
      form.reset()
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not create account')
    } finally {
      setSaving(false)
    }
  }

  async function removeAccount(id: number, name: string) {
    if (
      !confirm(
        `Delete account “${name}” and all its transactions? This cannot be undone.`
      )
    ) {
      return
    }
    setErr(null)
    try {
      await deleteReq(`/api/accounts/${id}`)
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not delete account')
    }
  }

  async function saveCard(id: number) {
    const name = editName.trim()
    const defaultCurrency = editCurrency.trim().toUpperCase()
    if (!name) {
      setErr('Name is required')
      return
    }
    if (!defaultCurrency) {
      setErr('Default currency is required')
      return
    }
    setErr(null)
    try {
      await patchJson<Account>(`/api/accounts/${id}`, {
        name,
        owner: editOwner,
        shortCode: editShortCode.trim() || null,
        defaultCurrency,
      })
      setEditingId(null)
      setEditName('')
      setEditOwner('me')
      setEditShortCode('')
      setEditCurrency('')
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not update account')
    }
  }

  function resetEditForm() {
    setEditingId(null)
    setEditName('')
    setEditOwner('me')
    setEditShortCode('')
    setEditCurrency('')
  }

  function startEdit(account: Account) {
    setEditingId(account.id)
    setEditName(account.name)
    setEditOwner((account.owner as 'me' | 'partner' | 'joint') ?? 'me')
    setEditShortCode(account.shortCode ?? '')
    setEditCurrency((account.defaultCurrency ?? 'CAD').toUpperCase())
  }

  const accountCount = accounts.length
  const shortCodeCount = accounts.filter((account) => account.shortCode).length
  const jointCount = accounts.filter((account) => account.owner === 'joint').length
  const currencyCount = new Set(
    accounts.map((account) => (account.defaultCurrency ?? 'CAD').toUpperCase())
  ).size

  return (
    <div className="page">
      <div className="accountsHeader">
        <h1>Accounts</h1>
        <p className="muted">
          Each account is a card or bank account. Use a short code (e.g.{' '}
          <code>Amex</code>) so folder imports can match{' '}
          <code>Amex_2025_01.csv</code>.
        </p>
      </div>

      <section className="accountsStats" aria-busy={loading}>
        <article className="card statCard">
          <p className="statLabel">Accounts</p>
          <p className="statValue">{accountCount}</p>
          <p className="muted statHint">Cards and bank accounts configured</p>
        </article>
        <article className="card statCard">
          <p className="statLabel">Short codes</p>
          <p className="statValue">{shortCodeCount}</p>
          <p className="muted statHint">Ready for folder import matching</p>
        </article>
        <article className="card statCard">
          <p className="statLabel">Joint</p>
          <p className="statValue">{jointCount}</p>
          <p className="muted statHint">Accounts owned together</p>
        </article>
        <article className="card statCard">
          <p className="statLabel">Currencies</p>
          <p className="statValue">{currencyCount}</p>
          <p className="muted statHint">Default currencies in use</p>
        </article>
      </section>

      <form className="card accountsFormCard" onSubmit={onCreate}>
        <div className="accountsCardHeader">
          <div>
            <h2>New account</h2>
            <p className="muted">
              Short codes are optional, but they make file naming and folder import much cleaner.
            </p>
          </div>
        </div>
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
            <select
              name="defaultCurrency"
              defaultValue="CAD"
            >
              {CURRENCY_OPTIONS.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </label>
        </div>
        <button type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Create account'}
        </button>
      </form>

      {err && <p className="error">{err}</p>}

      <section className="card accountsTableCard">
        <div className="accountsCardHeader">
          <div>
            <h2>Your accounts</h2>
            <p className="muted">
              Edit the basics here without cramming action buttons into the currency field.
            </p>
          </div>
          <span className="transactionsPanelBadge">{accountCount} total</span>
        </div>
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
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => (
                  <tr key={a.id}>
                    <td>
                      {editingId === a.id ? (
                        <input
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          placeholder="Account name"
                        />
                      ) : (
                        a.name
                      )}
                    </td>
                    <td>
                      {editingId === a.id ? (
                        <select
                          value={editOwner}
                          onChange={(e) =>
                            setEditOwner(
                              e.target.value as 'me' | 'partner' | 'joint'
                            )
                          }
                        >
                          <option value="me">me</option>
                          <option value="partner">partner</option>
                          <option value="joint">joint</option>
                        </select>
                      ) : (
                        a.owner
                      )}
                    </td>
                    <td>
                      {editingId === a.id ? (
                        <input
                          value={editShortCode}
                          onChange={(e) => setEditShortCode(e.target.value)}
                          placeholder="Short code"
                          maxLength={64}
                        />
                      ) : (
                        a.shortCode ?? '—'
                      )}
                    </td>
                    <td>
                      {editingId === a.id ? (
                        <select
                          value={editCurrency}
                          onChange={(e) => setEditCurrency(e.target.value)}
                        >
                          {CURRENCY_OPTIONS.map((code) => (
                            <option key={code} value={code}>
                              {code}
                            </option>
                          ))}
                        </select>
                      ) : (
                        a.defaultCurrency ?? 'CAD'
                      )}
                    </td>
                    <td>
                      <div className="accountsActionGroup">
                        {editingId === a.id ? (
                          <>
                            <button type="button" onClick={() => void saveCard(a.id)}>
                              Save
                            </button>
                            <button type="button" onClick={() => resetEditForm()}>
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button type="button" onClick={() => startEdit(a)}>
                            Edit
                          </button>
                        )}
                        <button
                          type="button"
                          className="btnDanger"
                          onClick={() => void removeAccount(a.id, a.name)}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {accounts.length === 0 && !loading && (
              <p className="emptyState pad">
                No accounts yet — create one using the form above, then import CSVs under Transactions.
              </p>
            )}
          </div>
        )}
      </section>
    </div>
  )
}
