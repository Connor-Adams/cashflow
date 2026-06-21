import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@connor-adams/designsystem'
import { Input } from '@connor-adams/designsystem'
import { NativeSelect } from '@connor-adams/designsystem'
import {
  getJson,
  getSimplefinAccounts,
  linkSimplefinAccount,
  unlinkSimplefinAccount,
} from '@/lib/api'
import type { Account, SimplefinAccountLinkState } from '@cashflow/shared'
import { ApiError } from '@/lib/api'

const ALREADY_LINKED_WARNING =
  'This account is already linked under another household member’s SimpleFIN connection. ' +
  'To avoid importing it twice, only one connection can own it. Ask them to unlink it first, ' +
  'or skip it here.'
const ROW_ERROR =
  'Something went wrong linking this account. Your data wasn’t changed — try again.'

type RowMode = 'existing' | 'create'

/**
 * SimpleFIN post-connect "link your accounts" step (issue #813).
 *
 * Lists the discovered SimpleFIN accounts (`GET /api/simplefin/accounts`) with
 * their current link state and lets the user link each one to an existing
 * Cashflow account, create a new account from it, or skip it. Reflects link /
 * unlink results in place without a full reload. Shown inside the connected
 * SimplefinConnectCard.
 */
export function SimplefinAccountLinkStep() {
  const [accounts, setAccounts] = useState<SimplefinAccountLinkState[] | null>(null)
  const [household, setHousehold] = useState<Account[]>([])
  const [loading, setLoading] = useState<boolean>(true)
  const [loadError, setLoadError] = useState<boolean>(false)
  const [skipped, setSkipped] = useState<Set<string>>(new Set())
  const mountedRef = useRef<boolean>(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  async function load() {
    setLoading(true)
    setLoadError(false)
    try {
      const [discovered, hh] = await Promise.all([
        getSimplefinAccounts(),
        getJson<Account[]>('/api/accounts').catch(() => [] as Account[]),
      ])
      if (mountedRef.current) {
        setAccounts(Array.isArray(discovered.accounts) ? discovered.accounts : [])
        setHousehold(
          Array.isArray(hh) ? hh.filter((a) => a.mergedIntoId == null) : [],
        )
      }
    } catch {
      if (mountedRef.current) {
        setAccounts(null)
        setLoadError(true)
      }
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  function patchRow(simplefinId: string, patch: Partial<SimplefinAccountLinkState>) {
    setAccounts((prev) =>
      prev == null
        ? prev
        : prev.map((a) => (a.simplefinId === simplefinId ? { ...a, ...patch } : a)),
    )
  }

  if (loading) {
    return (
      <p className="text-sm muted flex items-center gap-2 mt-3" data-testid="simplefin-accounts-loading">
        <Loader2 aria-hidden="true" className="size-4 animate-spin" />
        Loading your SimpleFIN accounts&hellip;
      </p>
    )
  }

  if (loadError) {
    return (
      <div className="mt-3" role="alert">
        <span className="error block mb-2">Couldn&rsquo;t load your SimpleFIN accounts.</span>
        <Button type="button" variant="outline" onClick={() => void load()}>
          Retry
        </Button>
      </div>
    )
  }

  if (!accounts || accounts.length === 0) {
    return (
      <p className="text-sm muted mt-3">
        SimpleFIN didn&rsquo;t return any accounts for this connection. Try syncing again later, or
        reconnect.
      </p>
    )
  }

  const allResolved = accounts.every(
    (a) => a.linkedAccountId != null || skipped.has(a.simplefinId),
  )

  return (
    <div className="mt-4">
      <h3 className="text-sm font-semibold m-0 mb-2">Link your accounts</h3>
      <ul className="flex flex-col gap-2 list-none p-0 m-0">
        {accounts.map((acc) => (
          <SimplefinAccountRow
            key={acc.simplefinId}
            account={acc}
            household={household}
            skipped={skipped.has(acc.simplefinId)}
            onLinked={(linkedAccountId) => patchRow(acc.simplefinId, { linkedAccountId })}
            onCreated={(account, linkedAccountId) => {
              setHousehold((prev) => [...prev, account])
              patchRow(acc.simplefinId, { linkedAccountId })
            }}
            onUnlinked={() => patchRow(acc.simplefinId, { linkedAccountId: null })}
            onSkip={() =>
              setSkipped((prev) => {
                const next = new Set(prev)
                next.add(acc.simplefinId)
                return next
              })
            }
          />
        ))}
      </ul>
      {allResolved && (
        <p className="text-sm muted mt-3" data-testid="simplefin-all-set">
          All set — your next sync will import these accounts.
        </p>
      )}
    </div>
  )
}

function SimplefinAccountRow(props: {
  account: SimplefinAccountLinkState
  household: Account[]
  skipped: boolean
  onLinked: (linkedAccountId: number) => void
  onCreated: (account: Account, linkedAccountId: number) => void
  onUnlinked: () => void
  onSkip: () => void
}) {
  const { account, household, skipped } = props
  const [mode, setMode] = useState<RowMode>('existing')
  const [selectedAccountId, setSelectedAccountId] = useState<string>(
    account.suggestedAccountId != null ? String(account.suggestedAccountId) : '',
  )
  const [newName, setNewName] = useState<string>(account.name)
  const [newCurrency, setNewCurrency] = useState<string>('CAD')
  const [busy, setBusy] = useState<boolean>(false)
  const [warning, setWarning] = useState<string | null>(
    account.alreadyLinkedElsewhere ? ALREADY_LINKED_WARNING : null,
  )
  const [rowError, setRowError] = useState<string | null>(null)
  const mountedRef = useRef<boolean>(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  function handleAlreadyLinked() {
    setWarning(ALREADY_LINKED_WARNING)
  }

  async function handleLinkExisting() {
    if (busy || !selectedAccountId) return
    setBusy(true)
    setRowError(null)
    setWarning(null)
    try {
      const res = await linkSimplefinAccount(account.simplefinId, {
        accountId: Number(selectedAccountId),
      })
      if (mountedRef.current && res.linkedAccountId != null) props.onLinked(res.linkedAccountId)
    } catch (e) {
      if (!mountedRef.current) return
      if (e instanceof ApiError && e.status === 409) handleAlreadyLinked()
      else setRowError(ROW_ERROR)
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }

  async function handleCreate() {
    if (busy || !newName.trim()) return
    setBusy(true)
    setRowError(null)
    setWarning(null)
    try {
      const res = await linkSimplefinAccount(account.simplefinId, {
        create: { name: newName.trim(), defaultCurrency: newCurrency },
      })
      if (mountedRef.current && res.linkedAccountId != null) {
        const created: Account = {
          id: res.linkedAccountId,
          name: newName.trim(),
          owner: 'me',
          householdId: null,
          ownerUserId: null,
          visibility: 'private',
          accountType: 'checking',
          shortCode: null,
          defaultCurrency: newCurrency,
          closedAt: null,
        }
        props.onCreated(created, res.linkedAccountId)
      }
    } catch (e) {
      if (!mountedRef.current) return
      if (e instanceof ApiError && e.status === 409) handleAlreadyLinked()
      else setRowError(ROW_ERROR)
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }

  async function handleUnlink() {
    if (busy) return
    setBusy(true)
    setRowError(null)
    try {
      await unlinkSimplefinAccount(account.simplefinId)
      if (mountedRef.current) props.onUnlinked()
    } catch {
      if (mountedRef.current) setRowError(ROW_ERROR)
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }

  // ── Linked summary ───────────────────────────────────────────────────────
  if (account.linkedAccountId != null) {
    const linked = household.find((a) => a.id === account.linkedAccountId)
    return (
      <li className="text-sm flex items-center justify-between gap-3 border border-[var(--border,#ddd)] rounded p-2">
        <span>
          SimpleFIN &ldquo;{account.name}&rdquo; →{' '}
          <strong>{linked ? linked.name : `account #${account.linkedAccountId}`}</strong>
        </span>
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void handleUnlink()}>
          Unlink
        </Button>
      </li>
    )
  }

  // ── Skipped ──────────────────────────────────────────────────────────────
  if (skipped) {
    return (
      <li className="text-sm muted flex items-center justify-between gap-3 border border-dashed border-[var(--border,#ddd)] rounded p-2">
        <span>
          SimpleFIN &ldquo;{account.name}&rdquo; — skipped
        </span>
      </li>
    )
  }

  // ── Unlinked: link controls ───────────────────────────────────────────────
  return (
    <li className="text-sm border border-[var(--border,#ddd)] rounded p-2 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <strong>{account.name}</strong>
        {account.suggestedAccountId != null && !account.alreadyLinkedElsewhere && (
          <span className="muted text-xs">
            We think this is your account — confirm to link.
          </span>
        )}
      </div>

      {warning && (
        <span className="error block" role="alert">
          {warning}
        </span>
      )}
      {rowError && (
        <span className="error block" role="alert">
          {rowError}
        </span>
      )}

      <div className="flex items-center gap-2">
        <NativeSelect
          size="sm"
          aria-label="Link mode"
          value={mode}
          onChange={(e) => setMode(e.target.value as RowMode)}
          disabled={busy}
        >
          <option value="existing">Link to existing account</option>
          <option value="create">Create a new account</option>
        </NativeSelect>
      </div>

      {mode === 'existing' ? (
        <div className="flex items-center gap-2 flex-wrap">
          <NativeSelect
            size="sm"
            aria-label="Existing account"
            value={selectedAccountId}
            onChange={(e) => setSelectedAccountId(e.target.value)}
            disabled={busy}
          >
            <option value="">Select an account&hellip;</option>
            {household.map((a) => (
              <option key={a.id} value={String(a.id)}>
                {a.name}
              </option>
            ))}
          </NativeSelect>
          <Button
            type="button"
            size="sm"
            disabled={busy || !selectedAccountId}
            onClick={() => void handleLinkExisting()}
          >
            {busy ? 'Linking…' : 'Link to existing account'}
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2 flex-wrap">
          <Input
            aria-label="New account name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            disabled={busy}
            placeholder="Account name"
          />
          <NativeSelect
            size="sm"
            aria-label="New account currency"
            value={newCurrency}
            onChange={(e) => setNewCurrency(e.target.value)}
            disabled={busy}
          >
            <option value="CAD">CAD</option>
            <option value="USD">USD</option>
            <option value="EUR">EUR</option>
            <option value="GBP">GBP</option>
          </NativeSelect>
          <Button
            type="button"
            size="sm"
            disabled={busy || !newName.trim()}
            onClick={() => void handleCreate()}
          >
            {busy ? 'Creating…' : 'Create a new account'}
          </Button>
        </div>
      )}

      <div>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={props.onSkip}>
          Skip for now
        </Button>
      </div>
    </li>
  )
}
