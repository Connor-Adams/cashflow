import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Edit3, Plus, Save, Trash2, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/ui/page-header'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { deleteReq, getJson, patchJson, postJson } from '../lib/api'
import type { Account, AccountType } from '../types/api'

const CURRENCY_OPTIONS = ['CAD', 'USD', 'EUR', 'GBP'] as const
const ACCOUNT_TYPE_OPTIONS: Array<{ value: AccountType; label: string }> = [
  { value: 'checking', label: 'Checking' },
  { value: 'savings', label: 'Savings' },
  { value: 'credit_card', label: 'Credit card' },
  { value: 'investment', label: 'Investment' },
  { value: 'cash', label: 'Cash' },
  { value: 'other', label: 'Other' },
]

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
  const [editAccountType, setEditAccountType] = useState<AccountType>('checking')
  const [editVisibility, setEditVisibility] = useState<'private' | 'shared'>('private')
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
        accountType: String(fd.get('accountType') ?? 'checking'),
        visibility: String(fd.get('visibility') ?? 'private'),
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
        accountType: editAccountType,
        visibility: editVisibility,
      })
      setEditingId(null)
      setEditName('')
      setEditOwner('me')
      setEditShortCode('')
      setEditCurrency('')
      setEditAccountType('checking')
      setEditVisibility('private')
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
    setEditAccountType('checking')
    setEditVisibility('private')
  }

  function startEdit(account: Account) {
    setEditingId(account.id)
    setEditName(account.name)
    setEditOwner((account.owner as 'me' | 'partner' | 'joint') ?? 'me')
    setEditShortCode(account.shortCode ?? '')
    setEditCurrency((account.defaultCurrency ?? 'CAD').toUpperCase())
    setEditAccountType(account.accountType ?? 'checking')
    setEditVisibility(account.visibility ?? 'private')
  }

  const accountCount = accounts.length
  const shortCodeCount = accounts.filter((account) => account.shortCode).length
  const jointCount = accounts.filter((account) => account.owner === 'joint').length
  const currencyCount = new Set(
    accounts.map((account) => (account.defaultCurrency ?? 'CAD').toUpperCase())
  ).size

  return (
    <div className="page">
      <PageHeader
        title="Accounts"
        description={
          <>
            Each account is a checking, card, cash, or investment account. Use a short code (e.g.{' '}
            <code>Amex</code>) so folder imports can match{' '}
            <code>Amex_2025_01.csv</code>.
          </>
        }
      />

      <section className="accountsStats" aria-busy={loading}>
        <Card className="statCard">
          <p className="statLabel">Accounts</p>
          <p className="statValue">{accountCount}</p>
          <p className="muted statHint">Cards and bank accounts configured</p>
        </Card>
        <Card className="statCard">
          <p className="statLabel">Short codes</p>
          <p className="statValue">{shortCodeCount}</p>
          <p className="muted statHint">Ready for folder import matching</p>
        </Card>
        <Card className="statCard">
          <p className="statLabel">Joint</p>
          <p className="statValue">{jointCount}</p>
          <p className="muted statHint">Accounts owned together</p>
        </Card>
        <Card className="statCard">
          <p className="statLabel">Currencies</p>
          <p className="statValue">{currencyCount}</p>
          <p className="muted statHint">Default currencies in use</p>
        </Card>
      </section>

      <Card className="accountsFormCard">
      <form onSubmit={onCreate}>
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
            <Input name="name" required placeholder="Amex Personal" />
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
            <Input
              name="shortCode"
              placeholder="Amex"
              maxLength={64}
              autoCapitalize="off"
            />
          </label>
          <label>
            Type
            <select name="accountType" defaultValue="checking">
              {ACCOUNT_TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
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
          <label>
            Visibility
            <select name="visibility" defaultValue="private">
              <option value="private">private</option>
              <option value="shared">shared</option>
            </select>
          </label>
        </div>
        <Button type="submit" disabled={saving}>
          <Plus aria-hidden="true" />
          {saving ? 'Saving…' : 'Create account'}
        </Button>
      </form>
      </Card>

      {err && <p className="error">{err}</p>}

      <Card className="accountsTableCard">
        <div className="accountsCardHeader">
          <div>
            <h2>Your accounts</h2>
            <p className="muted">
              Edit the basics here without cramming action buttons into the currency field.
            </p>
          </div>
          <Badge variant="secondary">{accountCount} total</Badge>
        </div>
        {loading ? (
          <p className="muted">Loading…</p>
        ) : (
          <div className="tableWrap">
            <Table className="table">
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Short code</TableHead>
                  <TableHead>Default currency</TableHead>
                  <TableHead>Visibility</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {accounts.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell>
                      {editingId === a.id ? (
                        <select
                          value={editAccountType}
                          onChange={(e) => setEditAccountType(e.target.value as AccountType)}
                        >
                          {ACCOUNT_TYPE_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        ACCOUNT_TYPE_OPTIONS.find((option) => option.value === a.accountType)?.label ?? a.accountType
                      )}
                    </TableCell>
                    <TableCell>
                      {editingId === a.id ? (
                        <Input
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          placeholder="Account name"
                        />
                      ) : (
                        a.name
                      )}
                    </TableCell>
                    <TableCell>
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
                    </TableCell>
                    <TableCell>
                      {editingId === a.id ? (
                        <Input
                          value={editShortCode}
                          onChange={(e) => setEditShortCode(e.target.value)}
                          placeholder="Short code"
                          maxLength={64}
                        />
                      ) : (
                        a.shortCode ?? '—'
                      )}
                    </TableCell>
                    <TableCell>
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
                    </TableCell>
                    <TableCell>
                      {editingId === a.id ? (
                        <select
                          value={editVisibility}
                          onChange={(e) =>
                            setEditVisibility(e.target.value as 'private' | 'shared')
                          }
                        >
                          <option value="private">private</option>
                          <option value="shared">shared</option>
                        </select>
                      ) : (
                        a.visibility
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="accountsActionGroup">
                        {editingId === a.id ? (
                          <>
                            <Button type="button" size="sm" onClick={() => void saveCard(a.id)}>
                              <Save aria-hidden="true" />
                              Save
                            </Button>
                            <Button type="button" size="sm" variant="secondary" onClick={() => resetEditForm()}>
                              <X aria-hidden="true" />
                              Cancel
                            </Button>
                          </>
                        ) : (
                          <Button type="button" size="sm" variant="secondary" onClick={() => startEdit(a)}>
                            <Edit3 aria-hidden="true" />
                            Edit
                          </Button>
                        )}
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          onClick={() => void removeAccount(a.id, a.name)}
                        >
                          <Trash2 aria-hidden="true" />
                          Delete
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {accounts.length === 0 && !loading && (
              <p className="emptyState pad">
                No accounts yet — create one using the form above, then import CSVs under Transactions.
              </p>
            )}
          </div>
        )}
      </Card>
    </div>
  )
}
