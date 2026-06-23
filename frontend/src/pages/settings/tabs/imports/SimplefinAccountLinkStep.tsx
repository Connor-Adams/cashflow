import { useEffect, useRef, useState } from 'react'
import { Button } from '@connor-adams/designsystem'
import { Input } from '@connor-adams/designsystem'
import { NativeSelect } from '@connor-adams/designsystem'
import { Spinner } from '@connor-adams/designsystem'
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
interface DiscoveredState {
  accounts: SimplefinAccountLinkState[] | null
  household: Account[]
  loading: boolean
  loadError: boolean
  load: () => void
  patchRow: (simplefinId: string, patch: Partial<SimplefinAccountLinkState>) => void
  addHouseholdAccount: (account: Account) => void
}

/** Loads the discovered accounts + household accounts and exposes local edits. */
function useDiscoveredAccounts(): DiscoveredState {
  const [accounts, setAccounts] = useState<SimplefinAccountLinkState[] | null>(null)
  const [household, setHousehold] = useState<Account[]>([])
  const [loading, setLoading] = useState<boolean>(true)
  const [loadError, setLoadError] = useState<boolean>(false)
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
      if (!mountedRef.current) return
      setAccounts(Array.isArray(discovered.accounts) ? discovered.accounts : [])
      setHousehold(Array.isArray(hh) ? hh.filter((a) => a.mergedIntoId == null) : [])
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
      prev == null ? prev : prev.map((a) => (a.simplefinId === simplefinId ? { ...a, ...patch } : a)),
    )
  }

  return {
    accounts,
    household,
    loading,
    loadError,
    load: () => void load(),
    patchRow,
    addHouseholdAccount: (account) => setHousehold((prev) => [...prev, account]),
  }
}

export function SimplefinAccountLinkStep() {
  const state = useDiscoveredAccounts()

  if (state.loading) {
    return (
      <p className="text-sm muted flex items-center gap-2 mt-3" data-testid="simplefin-accounts-loading">
        <Spinner aria-hidden="true" size={16} />
        Loading your SimpleFIN accounts&hellip;
      </p>
    )
  }
  if (state.loadError) {
    return (
      <div className="mt-3" role="alert">
        <span className="error block mb-2">Couldn&rsquo;t load your SimpleFIN accounts.</span>
        <Button type="button" variant="outline" onClick={state.load}>
          Retry
        </Button>
      </div>
    )
  }
  if (!state.accounts || state.accounts.length === 0) {
    return (
      <p className="text-sm muted mt-3">
        SimpleFIN didn&rsquo;t return any accounts for this connection. Try syncing again later, or
        reconnect.
      </p>
    )
  }
  return <LinkList state={state} accounts={state.accounts} />
}

function LinkList(props: { state: DiscoveredState; accounts: SimplefinAccountLinkState[] }) {
  const { state, accounts } = props
  const [skipped, setSkipped] = useState<Set<string>>(new Set())
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
            household={state.household}
            skipped={skipped.has(acc.simplefinId)}
            onLinked={(linkedAccountId) => state.patchRow(acc.simplefinId, { linkedAccountId })}
            onCreated={(account, linkedAccountId) => {
              state.addHouseholdAccount(account)
              state.patchRow(acc.simplefinId, { linkedAccountId })
            }}
            onUnlinked={() => state.patchRow(acc.simplefinId, { linkedAccountId: null })}
            onSkip={() => setSkipped((prev) => new Set(prev).add(acc.simplefinId))}
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

interface RowCallbacks {
  onLinked: (linkedAccountId: number) => void
  onCreated: (account: Account, linkedAccountId: number) => void
  onUnlinked: () => void
  onSkip: () => void
}

/**
 * Row mutation state + handlers (link-existing / create / unlink), kept out of
 * the render functions so each stays simple. `409` surfaces the already-linked
 * warning; any other failure surfaces the row error without changing the row.
 */
function useRowActions(account: SimplefinAccountLinkState, cb: RowCallbacks) {
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

  function handleFailure(e: unknown) {
    if (!mountedRef.current) return
    if (e instanceof ApiError && e.status === 409) setWarning(ALREADY_LINKED_WARNING)
    else setRowError(ROW_ERROR)
  }

  async function run(work: () => Promise<void>) {
    setBusy(true)
    setRowError(null)
    setWarning(null)
    try {
      await work()
    } catch (e) {
      handleFailure(e)
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }

  async function linkExisting(accountId: number) {
    await run(async () => {
      const res = await linkSimplefinAccount(account.simplefinId, { accountId })
      if (mountedRef.current && res.linkedAccountId != null) cb.onLinked(res.linkedAccountId)
    })
  }

  async function createAndLink(name: string, defaultCurrency: string) {
    await run(async () => {
      const res = await linkSimplefinAccount(account.simplefinId, {
        create: { name, defaultCurrency },
      })
      if (mountedRef.current && res.linkedAccountId != null) {
        cb.onCreated(newAccountStub(res.linkedAccountId, name, defaultCurrency), res.linkedAccountId)
      }
    })
  }

  async function unlink() {
    await run(async () => {
      await unlinkSimplefinAccount(account.simplefinId)
      if (mountedRef.current) cb.onUnlinked()
    })
  }

  return { busy, warning, rowError, linkExisting, createAndLink, unlink }
}

/** Optimistic local shape for a just-created account (id from the API). */
function newAccountStub(id: number, name: string, defaultCurrency: string): Account {
  return {
    id,
    name,
    owner: 'me',
    householdId: null,
    ownerUserId: null,
    visibility: 'private',
    accountType: 'checking',
    shortCode: null,
    defaultCurrency,
    closedAt: null,
  }
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
  const actions = useRowActions(account, props)

  if (account.linkedAccountId != null) {
    return <LinkedRow account={account} household={household} busy={actions.busy} onUnlink={actions.unlink} />
  }
  if (skipped) {
    return <SkippedRow account={account} />
  }
  return (
    <UnlinkedRow
      account={account}
      household={household}
      busy={actions.busy}
      warning={actions.warning}
      rowError={actions.rowError}
      onLinkExisting={actions.linkExisting}
      onCreate={actions.createAndLink}
      onSkip={props.onSkip}
    />
  )
}

function LinkedRow(props: {
  account: SimplefinAccountLinkState
  household: Account[]
  busy: boolean
  onUnlink: () => Promise<void>
}) {
  const { account, household, busy } = props
  const linked = household.find((a) => a.id === account.linkedAccountId)
  return (
    <li className="text-sm flex items-center justify-between gap-3 border border-[var(--border,#ddd)] rounded p-2">
      <span>
        SimpleFIN &ldquo;{account.name}&rdquo; →{' '}
        <strong>{linked ? linked.name : `account #${account.linkedAccountId}`}</strong>
      </span>
      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void props.onUnlink()}>
        Unlink
      </Button>
    </li>
  )
}

function SkippedRow(props: { account: SimplefinAccountLinkState }) {
  return (
    <li className="text-sm muted flex items-center justify-between gap-3 border border-dashed border-[var(--border,#ddd)] rounded p-2">
      <span>SimpleFIN &ldquo;{props.account.name}&rdquo; — skipped</span>
    </li>
  )
}

function UnlinkedRow(props: {
  account: SimplefinAccountLinkState
  household: Account[]
  busy: boolean
  warning: string | null
  rowError: string | null
  onLinkExisting: (accountId: number) => Promise<void>
  onCreate: (name: string, currency: string) => Promise<void>
  onSkip: () => void
}) {
  const { account, household, busy, warning, rowError } = props
  const [mode, setMode] = useState<RowMode>('existing')
  const showSuggestion =
    account.suggestedAccountId != null && !account.alreadyLinkedElsewhere

  return (
    <li className="text-sm border border-[var(--border,#ddd)] rounded p-2 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <strong>{account.name}</strong>
        {showSuggestion && (
          <span className="muted text-xs">We think this is your account — confirm to link.</span>
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

      {mode === 'existing' ? (
        <LinkExistingControls
          account={account}
          household={household}
          busy={busy}
          onLink={props.onLinkExisting}
        />
      ) : (
        <CreateAccountControls account={account} busy={busy} onCreate={props.onCreate} />
      )}

      <div>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={props.onSkip}>
          Skip for now
        </Button>
      </div>
    </li>
  )
}

function LinkExistingControls(props: {
  account: SimplefinAccountLinkState
  household: Account[]
  busy: boolean
  onLink: (accountId: number) => Promise<void>
}) {
  const { account, household, busy } = props
  const [selectedAccountId, setSelectedAccountId] = useState<string>(
    account.suggestedAccountId != null ? String(account.suggestedAccountId) : '',
  )
  return (
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
        onClick={() => void props.onLink(Number(selectedAccountId))}
      >
        {busy ? 'Linking…' : 'Link to existing account'}
      </Button>
    </div>
  )
}

function CreateAccountControls(props: {
  account: SimplefinAccountLinkState
  busy: boolean
  onCreate: (name: string, currency: string) => Promise<void>
}) {
  const { account, busy } = props
  const [newName, setNewName] = useState<string>(account.name)
  const [newCurrency, setNewCurrency] = useState<string>('CAD')
  return (
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
        onClick={() => void props.onCreate(newName.trim(), newCurrency)}
      >
        {busy ? 'Creating…' : 'Create a new account'}
      </Button>
    </div>
  )
}
