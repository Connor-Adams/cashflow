import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Edit3, GitMerge } from 'lucide-react'
import { Badge, Icon } from '@connor-adams/designsystem'
import { Button } from '@connor-adams/designsystem'
import { Card } from '@connor-adams/designsystem'
import { CollapsibleCard } from '@/components/ui/collapsible-card'
import { useConfirm } from '@/lib/ds-extras'
import { Input } from '@connor-adams/designsystem'
import { Label } from '@connor-adams/designsystem'
import { PageHeader } from '@/components/ui/page-header'
import { Alert } from '@connor-adams/designsystem'
import { EmptyTableRow } from '@/lib/ds-extras'
import { SkeletonRow } from '@/lib/ds-extras'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@connor-adams/designsystem'
import { useToast } from '@/components/ui/toast'
import { SectionHeader } from '@/components/ui/section-header'
import { Grid } from '@/lib/ds-extras'
import { StatCard } from '@connor-adams/designsystem'
import { UtilizationBadge } from '@/components/accounts/UtilizationBadge'
import { MergeAccountModal } from '@/components/accounts/MergeAccountModal'
import { deleteReq, getJson, patchJson, postJson } from '../lib/api'
import type { Account, AccountMergeResult, AccountType } from '../types/api'

function formatMoney(value: number | null | undefined, currency: string | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const code = (currency ?? 'CAD').toUpperCase()
  try {
    return new Intl.NumberFormat('en-CA', {
      style: 'currency',
      currency: code,
      maximumFractionDigits: 0,
    }).format(value)
  } catch {
    return `${value.toFixed(0)} ${code}`
  }
}

const CURRENCY_OPTIONS = ['CAD', 'USD', 'EUR', 'GBP'] as const
const ACCOUNT_TYPE_OPTIONS: Array<{ value: AccountType; label: string }> = [
  { value: 'checking', label: 'Checking' },
  { value: 'savings', label: 'Savings' },
  { value: 'credit_card', label: 'Credit card' },
  { value: 'investment', label: 'Investment' },
  { value: 'loan', label: 'Loan / line of credit' },
  { value: 'cash', label: 'Cash' },
  { value: 'other', label: 'Other' },
]

// Revolving credit (credit cards + `loan` lines of credit) carries a credit
// limit + utilization; mirrors the backend gate in routes/accounts.ts.
const REVOLVING_CREDIT_TYPES = new Set<AccountType>(['credit_card', 'loan'])
function isRevolvingCredit(type: AccountType): boolean {
  return REVOLVING_CREDIT_TYPES.has(type)
}

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
  const [editClosedAt, setEditClosedAt] = useState<string>('')
  const [editCreditLimit, setEditCreditLimit] = useState<string>('')
  const [editNotes, setEditNotes] = useState<string>('')
  const [mergeSource, setMergeSource] = useState<Account | null>(null)
  const loadRequestRef = useRef(0)
  const confirm = useConfirm()
  const { showToast } = useToast()
  const errorId = 'accounts-error'
  const hasError = Boolean(err)

  const load = useCallback(async () => {
    const requestId = ++loadRequestRef.current
    setLoading(true)
    setErr(null)
    try {
      // Fetch the full list (including merged sources) so we can render the
      // active rows AND the "Hidden / merged" section without a second request.
      const nextAccounts = await getJson<Account[]>('/api/accounts?includeMerged=true')
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

  async function removeAccount(account: Account) {
    const ok = await confirm({
      title: 'Delete account?',
      description: `“${account.name}” and all its transactions will be removed. Linked transactions cannot be restored by undo.`,
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    setErr(null)
    // Snapshot the account shape BEFORE the delete so the undo handler can
    // re-create it. Backend hard-cascades transactions on delete, so the
    // toast copy makes that limit explicit.
    const snapshot = {
      name: account.name,
      owner: account.owner,
      shortCode: account.shortCode,
      defaultCurrency: account.defaultCurrency,
      accountType: account.accountType,
      visibility: account.visibility,
    }
    try {
      await deleteReq(`/api/accounts/${account.id}`)
      await load()

      const revert = async () => {
        try {
          await postJson<Account>('/api/accounts', snapshot)
          await load()
          showToast({
            title: 'Account restored',
            description:
              'Linked transactions could not be recovered — re-import the CSVs to repopulate.',
            durationMs: 4000,
          })
        } catch (revertError) {
          setErr(
            revertError instanceof Error
              ? revertError.message
              : 'Could not restore account'
          )
        }
      }

      showToast({
        title: `Deleted account ${account.name}`,
        variant: 'success',
        durationMs: 10000,
        action: { label: 'Undo', onClick: () => void revert() },
      })
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
    // creditLimit only travels on the wire for revolving credit (credit cards +
    // lines of credit); sending it for other kinds would 400. Validate > 0 inline.
    let creditLimitPayload: number | null | undefined = undefined
    if (isRevolvingCredit(editAccountType)) {
      const trimmed = editCreditLimit.trim()
      if (trimmed === '') {
        creditLimitPayload = null
      } else {
        const n = Number(trimmed)
        if (!Number.isFinite(n) || n <= 0) {
          setErr('Limit must be greater than 0.')
          return
        }
        creditLimitPayload = n
      }
    }
    setErr(null)
    try {
      const payload: Record<string, unknown> = {
        name,
        owner: editOwner,
        shortCode: editShortCode.trim() || null,
        defaultCurrency,
        accountType: editAccountType,
        visibility: editVisibility,
        closedAt: editClosedAt.trim() || null,
      }
      if (creditLimitPayload !== undefined) payload.creditLimit = creditLimitPayload
      payload.notes = editNotes.trim() || null
      await patchJson<Account>(`/api/accounts/${id}`, payload)
      setEditingId(null)
      setEditName('')
      setEditOwner('me')
      setEditShortCode('')
      setEditCurrency('')
      setEditAccountType('checking')
      setEditVisibility('private')
      setEditClosedAt('')
      setEditCreditLimit('')
      setEditNotes('')
      showToast({ title: 'Account saved.', variant: 'success', durationMs: 2000 })
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
    setEditClosedAt('')
    setEditCreditLimit('')
    setEditNotes('')
  }

  function startEdit(account: Account) {
    setEditingId(account.id)
    setEditName(account.name)
    setEditOwner((account.owner as 'me' | 'partner' | 'joint') ?? 'me')
    setEditShortCode(account.shortCode ?? '')
    setEditCurrency((account.defaultCurrency ?? 'CAD').toUpperCase())
    setEditAccountType(account.accountType ?? 'checking')
    setEditVisibility(account.visibility ?? 'private')
    setEditClosedAt(account.closedAt ?? '')
    setEditCreditLimit(account.creditLimit != null ? String(account.creditLimit) : '')
    setEditNotes(account.notes ?? '')
  }

  function onMerged(result: AccountMergeResult) {
    setMergeSource(null)
    showToast({
      title: `Merged ${result.source.name} into ${result.target.name}`,
      description: `Moved ${result.movedTransactions} transaction${result.movedTransactions === 1 ? '' : 's'}.`,
      variant: 'success',
      durationMs: 4000,
    })
    void load()
  }

  // Active accounts drive the main table + stat tiles; merged sources are
  // pulled out into the collapsible "Hidden / merged" section (#287).
  const activeAccounts = useMemo(
    () => accounts.filter((a) => a.mergedIntoId == null),
    [accounts],
  )
  const mergedAccounts = useMemo(
    () => accounts.filter((a) => a.mergedIntoId != null),
    [accounts],
  )
  const accountNameById = useMemo(() => {
    const map = new Map<number, string>()
    for (const a of accounts) map.set(a.id, a.name)
    return map
  }, [accounts])

  const accountCount = activeAccounts.length
  const shortCodeCount = activeAccounts.filter((account) => account.shortCode).length
  const jointCount = activeAccounts.filter((account) => account.owner === 'joint').length
  const currencyCount = new Set(
    activeAccounts.map((account) => (account.defaultCurrency ?? 'CAD').toUpperCase())
  ).size

  return (
    <>
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

      <Grid minItemWidth={180} gap="md" responsiveFloor={false} className="mb-4" aria-busy={loading}>
        <StatCard label="Accounts" value={accountCount} hint="Cards and bank accounts configured" />
        <StatCard label="Short codes" value={shortCodeCount} hint="Ready for folder import matching" />
        <StatCard label="Joint" value={jointCount} hint="Accounts owned together" />
        <StatCard label="Currencies" value={currencyCount} hint="Default currencies in use" />
      </Grid>

      <Card className="mb-4">
      <form onSubmit={onCreate}>
        <SectionHeader
          title="New account"
          description="Short codes are optional, but they make file naming and folder import much cleaner."
        />
        <Grid minItemWidth={180} fill gap="md" className="mb-3">
          <Label htmlFor="accounts-create-name">
            Name <span className="text-danger">*</span>
            <Input
              id="accounts-create-name"
              name="name"
              required
              placeholder="Amex Personal"
              aria-invalid={hasError || undefined}
              aria-describedby={hasError ? errorId : undefined}
            />
          </Label>
          <Label htmlFor="accounts-create-owner">
            Owner
            <select id="accounts-create-owner" name="owner" defaultValue="me">
              <option value="me">me</option>
              <option value="partner">partner</option>
              <option value="joint">joint</option>
            </select>
          </Label>
          <Label htmlFor="accounts-create-short-code">
            Short code
            <Input
              id="accounts-create-short-code"
              name="shortCode"
              placeholder="Amex"
              maxLength={64}
              autoCapitalize="off"
            />
          </Label>
          <Label htmlFor="accounts-create-account-type">
            Type
            <select
              id="accounts-create-account-type"
              name="accountType"
              defaultValue="checking"
            >
              {ACCOUNT_TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Label>
          <Label htmlFor="accounts-create-default-currency">
            Default currency
            <select
              id="accounts-create-default-currency"
              name="defaultCurrency"
              defaultValue="CAD"
            >
              {CURRENCY_OPTIONS.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </Label>
          <Label htmlFor="accounts-create-visibility">
            Visibility
            <select
              id="accounts-create-visibility"
              name="visibility"
              defaultValue="private"
            >
              <option value="private">private</option>
              <option value="shared">shared</option>
            </select>
          </Label>
        </Grid>
        <Button type="submit" disabled={saving}>
          <Icon name="plus" aria-hidden="true" />
          {saving ? 'Saving…' : 'Create account'}
        </Button>
      </form>
      </Card>

      {err ? <Alert variant="error" className="mb-4" id={errorId}>{err}</Alert> : null}

      <CollapsibleCard
        id="your-accounts"
        className="mb-4"
        title="Your accounts"
        description="Edit the basics here without cramming action buttons into the currency field."
        actions={<Badge variant="secondary">{accountCount} total</Badge>}
      >
        <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Short code</TableHead>
                <TableHead>Default currency</TableHead>
                <TableHead>Visibility</TableHead>
                <TableHead>Closed</TableHead>
                <TableHead>Credit limit</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <SkeletonRow key={`accounts-skeleton-${i}`} cols={9} />
                ))
              ) : activeAccounts.length === 0 ? (
                <EmptyTableRow colSpan={9} title="No accounts yet" description="Create one using the form above, then import CSVs under Transactions." />
              ) : (
                activeAccounts.map((a) => (
                  <Fragment key={a.id}>
                  <TableRow className={a.closedAt ? 'opacity-60' : undefined}>
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
                        <div>
                          {a.name}
                          {a.notes && (
                            <p className="text-xs text-muted-foreground mt-0.5">
                              {a.notes.length > 100 ? `${a.notes.slice(0, 100)}…` : a.notes}
                            </p>
                          )}
                        </div>
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
                      {editingId === a.id ? (
                        <Input
                          type="date"
                          value={editClosedAt}
                          onChange={(e) => setEditClosedAt(e.target.value)}
                          placeholder="YYYY-MM-DD"
                        />
                      ) : a.closedAt ? (
                        <Badge variant="secondary">Closed {a.closedAt}</Badge>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell>
                      {editingId === a.id ? (
                        isRevolvingCredit(editAccountType) ? (
                          <Input
                            type="number"
                            inputMode="decimal"
                            min="0"
                            step="0.01"
                            value={editCreditLimit}
                            onChange={(e) => setEditCreditLimit(e.target.value)}
                            placeholder="e.g. 5000"
                            aria-label="Credit limit"
                          />
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )
                      ) : !isRevolvingCredit(a.accountType) ? (
                        <span className="text-muted-foreground">—</span>
                      ) : a.creditLimit == null ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          onClick={() => startEdit(a)}
                        >
                          Set credit limit
                        </Button>
                      ) : (
                        <div className="flex flex-col gap-1">
                          <span className="text-sm">
                            {formatMoney(a.currentBalance ?? 0, a.defaultCurrency)} /{' '}
                            {formatMoney(a.creditLimit, a.defaultCurrency)}
                          </span>
                          <UtilizationBadge utilizationPct={a.utilizationPct} />
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-2">
                        {editingId === a.id ? (
                          <>
                            <Button type="button" size="sm" onClick={() => void saveCard(a.id)}>
                              <Icon name="save" aria-hidden="true" />
                              Save
                            </Button>
                            <Button type="button" size="sm" variant="secondary" onClick={() => resetEditForm()}>
                              <Icon name="x" aria-hidden="true" />
                              Cancel
                            </Button>
                          </>
                        ) : (
                          <Button type="button" size="sm" variant="secondary" onClick={() => startEdit(a)}>
                            <Edit3 aria-hidden="true" />
                            Edit
                          </Button>
                        )}
                        {(() => {
                          const currency = (a.defaultCurrency ?? 'CAD').toUpperCase()
                          const hasTarget = activeAccounts.some(
                            (other) =>
                              other.id !== a.id &&
                              (other.defaultCurrency ?? 'CAD').toUpperCase() === currency,
                          )
                          return (
                            <Button
                              type="button"
                              size="sm"
                              variant="secondary"
                              onClick={() => setMergeSource(a)}
                              disabled={!hasTarget}
                              title={
                                hasTarget
                                  ? undefined
                                  : 'Need at least two same-currency accounts to merge.'
                              }
                            >
                              <GitMerge aria-hidden="true" />
                              Merge into…
                            </Button>
                          )
                        })()}
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          onClick={() => void removeAccount(a)}
                        >
                          <Icon name="trash" aria-hidden="true" />
                          Delete
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                  {editingId === a.id && (
                    <TableRow>
                      <TableCell colSpan={9}>
                        <div className="flex flex-col gap-1">
                          <label className="text-sm font-medium" htmlFor={`notes-${a.id}`}>
                            Notes
                          </label>
                          <textarea
                            id={`notes-${a.id}`}
                            value={editNotes}
                            onChange={(e) => setEditNotes(e.target.value)}
                            rows={3}
                            maxLength={4000}
                            placeholder="Routing number, custodian, tax ID, or any per-account reminder…"
                            className="w-full resize-y"
                          />
                          <span
                            className={`text-xs ${editNotes.length > 3800 ? 'text-destructive' : 'text-muted-foreground'}`}
                            aria-live="polite"
                          >
                            {editNotes.length}/4000
                          </span>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                  </Fragment>
                ))
              )}
            </TableBody>
          </Table>
      </CollapsibleCard>

      {mergedAccounts.length > 0 ? (
        <CollapsibleCard
          id="merged-accounts"
          className="mb-4"
          title="Hidden / merged accounts"
          description="These accounts were merged into another account. They are kept read-only for audit."
          actions={<Badge variant="secondary">{mergedAccounts.length} merged</Badge>}
          defaultOpen={false}
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Default currency</TableHead>
                <TableHead>Merged into</TableHead>
                <TableHead>Merged at</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {mergedAccounts.map((a) => (
                <TableRow key={a.id} className="opacity-60">
                  <TableCell>{a.name}</TableCell>
                  <TableCell>
                    {ACCOUNT_TYPE_OPTIONS.find((o) => o.value === a.accountType)?.label ??
                      a.accountType}
                  </TableCell>
                  <TableCell>{a.defaultCurrency ?? 'CAD'}</TableCell>
                  <TableCell>
                    {a.mergedIntoId != null
                      ? accountNameById.get(a.mergedIntoId) ?? `#${a.mergedIntoId}`
                      : '—'}
                  </TableCell>
                  <TableCell>{a.mergedAt ? a.mergedAt.slice(0, 10) : '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CollapsibleCard>
      ) : null}
    </div>
    {mergeSource ? (
      <MergeAccountModal
        source={mergeSource}
        accounts={activeAccounts}
        onClose={() => setMergeSource(null)}
        onMerged={onMerged}
      />
    ) : null}
    {confirm.dialog}
    </>
  )
}
