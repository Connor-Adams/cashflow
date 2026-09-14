/**
 * Per-person loan ledger (issue: per-person-loan-ledger). One-stop view of
 * each contact's raw transfer flow and their actual debt. Drill into a contact
 * to see their linked transfers, tag what each transfer meant, run the
 * "Link transfers" auto-matcher, and resolve ambiguous matches manually.
 *
 * Two numbers, and they are NOT the same number:
 *
 *   - `loanBalance` is the signed debt, folded from transfers that were tagged
 *     `loan`/`repayment` (or that fall under the contact's `loanDefault`). It
 *     is the ONLY number on this page allowed to say "owed" or "owe".
 *   - `transferNet` is raw movement — every dollar that crossed between you,
 *     rent and groceries and gifts included. It is a description, never a
 *     claim. Labelling it "owed to you" is exactly the bug this page shipped
 *     with; it reported ~79k of debt that was almost entirely not debt.
 *
 * Both are per-currency and neither collapses to a primary currency: a CAD
 * balance and a USD balance are different debts and are shown separately.
 */
import { useEffect, useState, useCallback, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Badge, Icon } from '@connor-adams/designsystem'
import { Button } from '@connor-adams/designsystem'
import { Card } from '@connor-adams/designsystem'
import { Label, NativeSelect, Switch } from '@connor-adams/designsystem'
import { EmptyTableRow } from '@/lib/ds-extras'
import { PageHeader } from '@/components/ui/page-header'
import { SkeletonRow } from '@/lib/ds-extras'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@connor-adams/designsystem'
import { useToast } from '@/components/ui/toast'
import type {
  ContactLedgerResponse,
  CounterpartyRole,
  SelfSuggestion,
  TransferLinkResult,
} from '@cashflow/shared'
import { COUNTERPARTY_ROLES } from '@cashflow/shared'
import {
  getJson,
  getContactLedger,
  previewTransferLink,
  commitTransferLink,
  markTransactionAsLoan,
  setTransactionContact,
  getSelfSuggestions,
  setContactSelf,
  setCounterpartyRole,
  setContactLoanDefault,
} from '../lib/api'
import { formatBalanceLabel, formatNetFlowLabel } from '../lib/peopleLedger'
import { formatMoney } from '../lib/formatMoney'

// ── Local types ──────────────────────────────────────────────────────────────

interface ContactLite {
  id: number
  name: string
  isSelf: boolean
  isPartner: boolean
}

interface ContactWithLedger {
  contact: ContactLite
  ledger: ContactLedgerResponse | null
}

/** Date, Merchant, Amount, Direction, Role, actions. */
const TRANSFER_COL_COUNT = 6

/** Landing columns: Contact, Loan balance, Raw net flow, Outstanding loans, Flow. */
const LANDING_COL_COUNT = 5

/** Display names for the role vocabulary. Keyed exhaustively so a new role in
 *  `COUNTERPARTY_ROLES` fails typecheck here rather than rendering a raw slug. */
const ROLE_LABELS: Record<CounterpartyRole, string> = {
  loan: 'Loan',
  repayment: 'Repayment',
  purchase: 'Purchase',
  business: 'Business',
  rent: 'Rent',
  gift: 'Gift',
  self: 'Self',
  loc_interest: 'LOC interest',
}

// ── Helpers ──────────────────────────────────────────────────────────────────

interface BarSegment {
  currency: string
  lent: number
  repaid: number
  balance: number
  /** Share of what was lent that is still outstanding, 0–100. */
  outstandingPct: number
  /** Share of what was lent that has come back, 0–100. */
  repaidPct: number
}

/**
 * Lent/repaid bar widths per currency, read off the *loan balance* rather than
 * raw flow — a bar drawn from raw flow is a picture of movement, not of debt.
 *
 * One segment per currency with something lent; currencies are never merged.
 * Returns an empty array when the contact has no tracked lending at all, so a
 * non-lending contact renders net-flow text and no bar. (The brief called for
 * `null` here; an empty array is the same "nothing to draw" signal in the
 * shape the per-currency requirement forces.)
 */
function computeBarSegments(ledger: ContactLedgerResponse | null): BarSegment[] {
  if (!ledger) return []
  const segments: BarSegment[] = []
  for (const b of ledger.loanBalance) {
    const lent = Math.abs(Number(b.lent))
    const repaid = Math.abs(Number(b.repaid))
    const balance = Number(b.balance)
    if (!Number.isFinite(lent) || lent === 0) continue
    const repaidPct = Math.min(100, (repaid / lent) * 100)
    segments.push({
      currency: b.currency,
      lent,
      repaid,
      balance,
      repaidPct,
      outstandingPct: Math.max(0, 100 - repaidPct),
    })
  }
  return segments
}

/** What a currency's debts add up to, in each direction. Never netted. */
interface CurrencyTotals {
  /** Sum of the positive balances — what people owe you. */
  owedToYou: number
  /** Sum of the negative balances, as a positive number — what you owe. */
  youOwe: number
}

/** Cents. Keeps float accumulation from leaking a 1e-13 residue into a label. */
function roundCents(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Top-level metrics across all loaded ledgers.
 *
 * Two independent axes, and the totals cross NEITHER of them:
 *
 *  - **Currency.** Every currency a contact carries is summed. The old version
 *    took the CAD row (or whichever row happened to be first) and dropped the
 *    rest, which silently hid a real USD −3,570.51 balance in production.
 *  - **Direction.** Owed-to-you and you-owe are accumulated separately rather
 *    than netted across people. Netting would let "Caelan owes you 3,648" and
 *    "you owe someone else 3,648" cancel into `CAD 0.00 settled` — a headline
 *    asserting nothing is outstanding while two live debts sit underneath it.
 *    That is the same false-claim bug as the one this page is being fixed for,
 *    one level up.
 *
 * Contacts whose ledger failed to load contribute nothing here and are
 * reported separately — see `failedLedgerIds` at the call site. An absent
 * ledger is not a zero balance.
 */
function deriveMetrics(cwl: ContactWithLedger[]): {
  balanceByCurrency: Map<string, CurrencyTotals>
  trackedLoansCount: number
} {
  const balanceByCurrency = new Map<string, CurrencyTotals>()
  let trackedLoansCount = 0
  const seen = new Set<number>()
  for (const { contact, ledger } of cwl) {
    if (contact.isSelf || contact.isPartner || !ledger) continue
    for (const b of ledger.loanBalance) {
      const v = Number(b.balance)
      if (!Number.isFinite(v) || v === 0) continue
      const totals = balanceByCurrency.get(b.currency) ?? { owedToYou: 0, youOwe: 0 }
      if (v > 0) totals.owedToYou += v
      else totals.youOwe += -v
      balanceByCurrency.set(b.currency, totals)
    }
    const loanCount = Object.keys(ledger.trackedOutstandingByCurrency).filter(
      (cur) => Number(ledger.trackedOutstandingByCurrency[cur]) > 0,
    ).length
    if (loanCount > 0 && !seen.has(contact.id)) {
      seen.add(contact.id)
      trackedLoansCount++
    }
  }
  for (const [currency, t] of balanceByCurrency) {
    balanceByCurrency.set(currency, {
      owedToYou: roundCents(t.owedToYou),
      youOwe: roundCents(t.youOwe),
    })
  }
  return { balanceByCurrency, trackedLoansCount }
}

/** Largest absolute balance a contact carries in any currency; the sort key. */
function peakBalance(ledger: ContactLedgerResponse | null): number {
  if (!ledger) return 0
  let peak = 0
  for (const b of ledger.loanBalance) {
    const v = Math.abs(Number(b.balance))
    if (Number.isFinite(v) && v > peak) peak = v
  }
  return peak
}

/** How many rows carry a tag that fought their direction. Direction won. */
function countMismatches(ledger: ContactLedgerResponse | null): number {
  if (!ledger) return 0
  return ledger.transfers.filter((t) => t.roleMismatch).length
}

// ── MetricCard ───────────────────────────────────────────────────────────────

function MetricCard({
  label,
  value,
}: {
  label: string
  value: string | number
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  )
}

// ── LoanBar ──────────────────────────────────────────────────────────────────

/**
 * One horizontal stacked bar per currency: outstanding (solid) + repaid
 * (lighter). Draws nothing for a contact with no tracked lending.
 */
function LoanBar({ ledger }: { ledger: ContactLedgerResponse | null }) {
  const segments = computeBarSegments(ledger)
  if (segments.length === 0) return null
  return (
    <div className="flex flex-col gap-2">
      {segments.map((s) => (
        <div key={s.currency} className="flex flex-col gap-1">
          <div
            role="img"
            className="relative h-2 w-full overflow-hidden rounded-full bg-muted"
            aria-label={`Loan balance bar: ${formatBalanceLabel({ currency: s.currency, balance: String(s.balance) })}`}
          >
            {/* repaid portion — lighter accent */}
            <div
              className="absolute right-0 top-0 h-full bg-primary/20"
              style={{ width: `${s.repaidPct.toFixed(1)}%` }}
            />
            {/* outstanding portion — solid primary */}
            <div
              className="absolute left-0 top-0 h-full bg-primary"
              style={{ width: `${s.outstandingPct.toFixed(1)}%` }}
            />
          </div>
          <div className="text-xs text-muted-foreground">
            lent {formatMoney(s.lent, s.currency)} ·{' '}
            {s.outstandingPct > 0 ? `${s.outstandingPct.toFixed(0)}% outstanding` : 'fully repaid'}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── RoleSelect ───────────────────────────────────────────────────────────────

/**
 * Per-row role tag. The empty option hands the row back to the contact's
 * `loanDefault` rather than asserting anything about it.
 */
function RoleSelect({
  txnId,
  rowLabel,
  value,
  disabled,
  onChange,
}: {
  txnId: number
  /** How the row reads on screen — a database id names nothing to the user. */
  rowLabel: string
  value: CounterpartyRole | null
  disabled: boolean
  onChange: (role: CounterpartyRole | null) => void
}) {
  return (
    <NativeSelect
      size="sm"
      aria-label={`Role for ${rowLabel}`}
      data-testid={`role-select-${txnId}`}
      disabled={disabled}
      value={value ?? ''}
      onChange={(e) =>
        onChange(e.target.value === '' ? null : (e.target.value as CounterpartyRole))
      }
    >
      <option value="">Auto (contact default)</option>
      {COUNTERPARTY_ROLES.map((r) => (
        <option key={r} value={r}>
          {ROLE_LABELS[r]}
        </option>
      ))}
    </NativeSelect>
  )
}

// ── SelfAccountSection ───────────────────────────────────────────────────────

function SelfAccountSection({
  suggestions,
  onExclude,
  excluding,
}: {
  suggestions: SelfSuggestion[]
  onExclude: (id: number) => void
  excluding: Set<number>
}) {
  if (suggestions.length === 0) return null
  return (
    <div className="mb-4" data-testid="self-account-section">
      <div className="mb-2 flex items-center gap-2">
        <Icon name="user-x" className="size-4 text-muted-foreground" aria-hidden="true" />
        <span className="text-sm font-medium text-muted-foreground">
          These look like your own accounts
        </span>
      </div>
      <div className="flex flex-col gap-2">
        {suggestions.map((s) => (
          <div
            key={s.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-input bg-muted/30 px-3 py-2"
            data-testid={`self-suggestion-${s.id}`}
          >
            <div>
              <div className="text-sm font-medium">{s.name}</div>
              <div className="text-xs text-muted-foreground" data-testid={`self-reason-${s.id}`}>{s.reason}</div>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={excluding.has(s.id)}
              onClick={() => onExclude(s.id)}
              data-testid={`exclude-btn-${s.id}`}
            >
              {excluding.has(s.id) ? 'Excluding…' : 'Not a person — exclude'}
            </Button>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── PeopleLedgerPage ─────────────────────────────────────────────────────────

export function PeopleLedgerPage() {
  const { showToast } = useToast()
  // Stable ref so loadAll doesn't need showToast in its dep array
  const showToastRef = useRef(showToast)
  showToastRef.current = showToast

  const [params, setParams] = useSearchParams()
  const selectedId = params.get('contact') ? Number(params.get('contact')) : null

  // Landing state
  const [contacts, setContacts] = useState<ContactLite[]>([])
  const [contactsLoading, setContactsLoading] = useState(true)
  const [ledgerMap, setLedgerMap] = useState<Map<number, ContactLedgerResponse>>(new Map())
  const [ledgersLoading, setLedgersLoading] = useState(false)
  // Contacts whose ledger fetch failed. Kept apart from "loaded with no debt":
  // rendering an unknown balance as "No tracked loans" would assert zero debt
  // for someone who may owe thousands — the same false claim, by omission.
  const [failedLedgerIds, setFailedLedgerIds] = useState<Set<number>>(new Set())
  const [selfSuggestions, setSelfSuggestions] = useState<SelfSuggestion[]>([])
  const [excluding, setExcluding] = useState<Set<number>>(new Set())

  // Drill-in state
  const [ledger, setLedger] = useState<ContactLedgerResponse | null>(null)
  const [ledgerLoading, setLedgerLoading] = useState(false)
  const [linkResult, setLinkResult] = useState<TransferLinkResult | null>(null)
  const [linking, setLinking] = useState(false)
  const [savingRole, setSavingRole] = useState<Set<number>>(new Set())
  const [savingDefault, setSavingDefault] = useState(false)

  // ── Load contacts + per-contact ledgers + self-suggestions ──────────────

  const loadAll = useCallback(async (isActive: () => boolean = () => true) => {
    if (isActive()) setContactsLoading(true)
    try {
      const [rawContacts, suggestionsResp] = await Promise.all([
        getJson<ContactLite[]>('/api/contacts'),
        getSelfSuggestions().catch(() => ({ suggestions: [] as SelfSuggestion[] })),
      ])
      if (isActive()) setContacts(rawContacts)
      if (isActive()) setSelfSuggestions(suggestionsResp.suggestions)

      // Fetch ledgers for all non-self, non-partner contacts in parallel (small N)
      const realContacts = rawContacts.filter((c) => !c.isSelf && !c.isPartner)
      if (realContacts.length > 0) {
        if (isActive()) setLedgersLoading(true)
        const entries = await Promise.all(
          realContacts.map((c) =>
            getContactLedger(c.id)
              .then((l) => [c.id, l] as [number, ContactLedgerResponse])
              .catch(() => c.id),
          ),
        )
        const m = new Map<number, ContactLedgerResponse>()
        const failed = new Set<number>()
        for (const e of entries) {
          if (Array.isArray(e)) m.set(e[0], e[1])
          else failed.add(e)
        }
        if (isActive()) setLedgerMap(m)
        if (isActive()) setFailedLedgerIds(failed)
        if (isActive()) setLedgersLoading(false)
        if (isActive() && failed.size > 0) {
          showToastRef.current({
            title:
              failed.size === 1
                ? "Couldn't load 1 contact's balance"
                : `Couldn't load ${failed.size} contacts' balances`,
            variant: 'destructive',
          })
        }
      }
    } catch (e) {
      if (isActive()) showToastRef.current({
        title: e instanceof Error ? e.message : 'Failed to load contacts',
        variant: 'destructive',
      })
    } finally {
      if (isActive()) setContactsLoading(false)
    }
    // showToastRef is a stable ref — intentionally excluded from dep array
  }, [])

  useEffect(() => {
    let active = true
    void loadAll(() => active)
    return () => { active = false }
  }, [loadAll])

  // ── Load drill-in ledger ──────────────────────────────────────────────────

  /**
   * Monotonic token shared by the navigation effect and `reload`. Every fetch
   * takes the next value and only applies its result if it still holds it, so
   * a late refetch can never paint one contact's ledger onto another's page,
   * and two rapid role tags settle on the newer answer rather than whichever
   * response happened to land last.
   */
  const ledgerRequestRef = useRef(0)

  useEffect(() => {
    if (selectedId == null) { ledgerRequestRef.current++; setLedger(null); return }
    const token = ++ledgerRequestRef.current
    const isCurrent = () => token === ledgerRequestRef.current
    setLedgerLoading(true)
    getContactLedger(selectedId)
      .then((data) => { if (isCurrent()) setLedger(data) })
      .catch(() => { if (isCurrent()) setLedger(null) })
      .finally(() => { if (isCurrent()) setLedgerLoading(false) })
  }, [selectedId])

  /**
   * Refetch the ledger. Required after any write that changes the balance:
   * `PATCH /api/transactions/:id` does not echo `counterpartyRole` back, and
   * the balance is recomputed server-side anyway, so there is nothing local to
   * patch optimistically.
   *
   * Deliberately does NOT raise `ledgerLoading` — that swaps the whole card and
   * table for "Loading…", and with a role dropdown on every row it would blink
   * the table away on each tag. The control that was used is disabled for the
   * duration instead (`savingRole` / `savingDefault`), which is the localised
   * affordance; a failed refetch leaves the previous ledger on screen.
   */
  const reload = useCallback(async () => {
    if (selectedId == null) return
    const token = ++ledgerRequestRef.current
    try {
      const data = await getContactLedger(selectedId)
      // Discard if the user navigated away or a newer refetch superseded us.
      if (token === ledgerRequestRef.current) setLedger(data)
    } catch {
      // Keep the ledger on screen; the failing write already toasted.
    }
  }, [selectedId])

  // ── Drill-in actions ──────────────────────────────────────────────────────

  async function onMarkLoan(txnId: number) {
    if (selectedId == null) return
    try {
      await markTransactionAsLoan(txnId, selectedId)
      showToastRef.current({ title: 'Marked as loan', variant: 'success' })
      await reload()
    } catch (e) {
      showToastRef.current({ title: e instanceof Error ? e.message : 'Update failed', variant: 'destructive' })
    }
  }

  async function onSetRole(txnId: number, role: CounterpartyRole | null) {
    setSavingRole((prev) => new Set([...prev, txnId]))
    try {
      await setCounterpartyRole(txnId, role)
      // The PATCH response omits counterpartyRole, so the ledger is the only
      // source of truth for what the row now means and what it did to the
      // balance — refetch rather than trusting the write.
      await reload()
    } catch (e) {
      showToastRef.current({ title: e instanceof Error ? e.message : 'Tag failed', variant: 'destructive' })
    } finally {
      setSavingRole((prev) => {
        const next = new Set(prev)
        next.delete(txnId)
        return next
      })
    }
  }

  async function onToggleLoanDefault(next: boolean) {
    if (ledger == null) return
    setSavingDefault(true)
    try {
      await setContactLoanDefault(ledger.contactId, next)
      await reload()
    } catch (e) {
      showToastRef.current({ title: e instanceof Error ? e.message : 'Update failed', variant: 'destructive' })
    } finally {
      setSavingDefault(false)
    }
  }

  async function onPreviewLink() {
    try {
      const r = await previewTransferLink()
      setLinkResult(r)
    } catch (e) {
      showToastRef.current({ title: e instanceof Error ? e.message : 'Preview failed', variant: 'destructive' })
    }
  }

  async function onCommitLink() {
    setLinking(true)
    try {
      const r = await commitTransferLink()
      setLinkResult(r)
      showToastRef.current({ title: 'Transfers linked', variant: 'success' })
      await reload()
    } catch (e) {
      showToastRef.current({ title: e instanceof Error ? e.message : 'Link failed', variant: 'destructive' })
    } finally {
      setLinking(false)
    }
  }

  async function onResolveAmbiguous(txnId: number, contactId: number) {
    try {
      await setTransactionContact(txnId, contactId)
      const r = await previewTransferLink()
      setLinkResult(r)
      showToastRef.current({ title: 'Contact assigned', variant: 'success' })
    } catch (e) {
      showToastRef.current({ title: e instanceof Error ? e.message : 'Assign failed', variant: 'destructive' })
    }
  }

  // ── Self-account exclusion ────────────────────────────────────────────────

  async function onExclude(id: number) {
    setExcluding((prev) => new Set([...prev, id]))
    try {
      await setContactSelf(id, true)
      showToastRef.current({ title: 'Contact excluded as self-account', variant: 'success' })
      await loadAll()
    } catch (e) {
      showToastRef.current({ title: e instanceof Error ? e.message : 'Exclude failed', variant: 'destructive' })
    } finally {
      setExcluding((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  // ── Derived ───────────────────────────────────────────────────────────────

  const ambiguous = linkResult?.ambiguous ?? []

  // Non-self, non-partner contacts sorted by their largest debt in any currency
  // — the page leads with the balance, so it sorts by the balance too.
  const realContacts = contacts.filter((c) => !c.isSelf && !c.isPartner)
  const sortedContacts = [...realContacts].sort(
    (a, b) => peakBalance(ledgerMap.get(b.id) ?? null) - peakBalance(ledgerMap.get(a.id) ?? null),
  )

  const selfContacts = contacts.filter((c) => c.isSelf)

  const cwl: ContactWithLedger[] = sortedContacts.map((c) => ({
    contact: c,
    ledger: ledgerMap.get(c.id) ?? null,
  }))
  const { balanceByCurrency, trackedLoansCount } = deriveMetrics(cwl)
  // Drop any currency whose two sides both rounded away to zero, so the
  // "Nothing outstanding" fallback below can't be skipped by an empty entry.
  const balanceEntries = [...balanceByCurrency.entries()]
    .filter(([, t]) => t.owedToYou > 0 || t.youOwe > 0)
    .sort(([a], [b]) => a.localeCompare(b))
  const mismatchCount = countMismatches(ledger)

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="page">
      <PageHeader
        title="People"
        description="Who actually owes whom, and the raw transfer flow behind it."
      />

      {/* Link-transfers action bar */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        {selectedId != null && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setParams({})}
          >
            ← All contacts
          </Button>
        )}
        <div className="ml-auto flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onPreviewLink}
          >
            Preview link
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={linking}
            onClick={onCommitLink}
          >
            {linking ? 'Linking…' : 'Link transfers'}
          </Button>
        </div>
      </div>

      {/* Ambiguous manual-pick queue */}
      {ambiguous.length > 0 && (
        <Card className="mb-4 p-4">
          <div className="mb-2 flex items-center gap-2">
            <Icon name="alert-triangle" className="size-4 text-warning" aria-hidden="true" />
            <span className="text-sm font-medium">Ambiguous matches — pick the right contact</span>
          </div>
          <div className="flex flex-col gap-2">
            {ambiguous.map((a) => (
              <div key={a.txnId} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted-foreground">{a.merchantText}</span>
                {a.contactIds.map((cid) => {
                  const label = contacts.find((c) => c.id === cid)?.name ?? `#${cid}`
                  return (
                    <Button
                      key={cid}
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => onResolveAmbiguous(a.txnId, cid)}
                    >
                      {label}
                    </Button>
                  )
                })}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* ── Landing: contact list with numbers ── */}
      {selectedId == null && (
        <>
          {/* Metric cards */}
          {!contactsLoading && !ledgersLoading && (
            <Card className="mb-4 p-4" data-testid="metrics-card">
              <div className="flex flex-wrap gap-8" data-testid="loan-balance-metrics">
                {balanceEntries.length === 0 ? (
                  <MetricCard label="Loan balance" value="Nothing outstanding" />
                ) : (
                  balanceEntries.flatMap(([currency, totals]) => {
                    // Both directions get their own tile. Netting them would
                    // let equal-and-opposite debts read as "settled".
                    const cards = []
                    if (totals.owedToYou > 0) {
                      cards.push(
                        <MetricCard
                          key={`${currency}-owed-to-you`}
                          label={`Owed to you · ${currency}`}
                          value={formatBalanceLabel({ currency, balance: String(totals.owedToYou) })}
                        />,
                      )
                    }
                    if (totals.youOwe > 0) {
                      cards.push(
                        <MetricCard
                          key={`${currency}-you-owe`}
                          label={`You owe · ${currency}`}
                          value={formatBalanceLabel({ currency, balance: String(-totals.youOwe) })}
                        />,
                      )
                    }
                    return cards
                  })
                )}
                <MetricCard
                  label="People"
                  value={realContacts.length}
                />
                <MetricCard
                  label="Tracked loans"
                  value={trackedLoansCount}
                />
                <MetricCard
                  label="Flagged to exclude"
                  value={selfContacts.length + selfSuggestions.length}
                />
              </div>
            </Card>
          )}

          {/* Self-account confirmation section */}
          <SelfAccountSection
            suggestions={selfSuggestions}
            onExclude={onExclude}
            excluding={excluding}
          />

          {/* Contact list */}
          <Card className="overflow-x-auto p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Contact</TableHead>
                  <TableHead>Loan balance</TableHead>
                  <TableHead>Raw transfer flow</TableHead>
                  <TableHead>Outstanding loans</TableHead>
                  <TableHead>Lent vs repaid</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {contactsLoading || ledgersLoading ? (
                  Array.from({ length: 3 }).map((_, i) => (
                    <SkeletonRow key={`people-skel-${i}`} cols={LANDING_COL_COUNT} />
                  ))
                ) : sortedContacts.length === 0 ? (
                  <EmptyTableRow
                    colSpan={LANDING_COL_COUNT}
                    title="No contacts yet."
                    description="Add contacts in Settings to start tracking transfers with them."
                  />
                ) : (
                  sortedContacts.map((c) => {
                    const cl = ledgerMap.get(c.id)
                    return (
                      <TableRow
                        key={c.id}
                        className="cursor-pointer hover:bg-muted/50"
                        onClick={() => setParams({ contact: String(c.id) })}
                        data-testid={`contact-row-${c.id}`}
                      >
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Icon name="users" className="size-4 text-muted-foreground" aria-hidden="true" />
                            <span>{c.name}</span>
                          </div>
                        </TableCell>
                        <TableCell data-testid={`balance-${c.id}`}>
                          {failedLedgerIds.has(c.id) ? (
                            <span className="text-sm text-muted-foreground">Couldn&apos;t load</span>
                          ) : cl && cl.loanBalance.length > 0 ? (
                            <div className="flex flex-col gap-0.5">
                              {cl.loanBalance.map((b) => (
                                <span key={b.currency} className="text-sm font-medium">
                                  {formatBalanceLabel(b)}
                                </span>
                              ))}
                            </div>
                          ) : (
                            <span className="text-sm text-muted-foreground">No tracked loans</span>
                          )}
                        </TableCell>
                        <TableCell data-testid={`net-${c.id}`}>
                          {failedLedgerIds.has(c.id) ? (
                            <span className="text-sm text-muted-foreground">—</span>
                          ) : cl && cl.transferNet.length > 0 ? (
                            <div className="flex flex-col gap-0.5">
                              {cl.transferNet.map((n) => (
                                <span key={n.currency} className="text-sm text-muted-foreground">
                                  {formatNetFlowLabel(n)}
                                </span>
                              ))}
                            </div>
                          ) : (
                            <span className="text-sm text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {cl && Object.keys(cl.trackedOutstandingByCurrency).some(
                            (cur) => Number(cl.trackedOutstandingByCurrency[cur]) > 0,
                          ) ? (
                            <div className="flex flex-col gap-0.5">
                              {Object.entries(cl.trackedOutstandingByCurrency)
                                .filter(([, amt]) => Number(amt) > 0)
                                .map(([cur, amt]) => (
                                  <span key={cur} className="text-sm font-medium">
                                    {formatMoney(Number(amt), cur)}
                                  </span>
                                ))}
                            </div>
                          ) : (
                            <span className="text-sm text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="min-w-32">
                          <LoanBar ledger={cl ?? null} />
                        </TableCell>
                      </TableRow>
                    )
                  })
                )}
              </TableBody>
            </Table>
          </Card>

          {/* Excluded / self-account contacts shown muted below */}
          {selfContacts.length > 0 && (
            <div className="mt-4" data-testid="excluded-contacts">
              <div className="mb-2 flex items-center gap-2">
                <Icon name="user-x" className="size-4 text-muted-foreground" aria-hidden="true" />
                <span className="text-xs uppercase tracking-wide text-muted-foreground">
                  Excluded — own accounts
                </span>
              </div>
              <div className="flex flex-col gap-1">
                {selfContacts.map((c) => (
                  <div
                    key={c.id}
                    className="flex items-center gap-2 px-1 py-0.5 text-sm text-muted-foreground"
                  >
                    <span>{c.name}</span>
                    <Badge variant="secondary">self-account</Badge>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* ── Drill-in: contact ledger detail view ── */}
      {selectedId != null && (
        <>
          {ledgerLoading ? (
            <Card className="mb-4 p-4">
              <div className="text-muted-foreground text-sm">Loading…</div>
            </Card>
          ) : ledger ? (
            <>
              {/* Summary card: the debt, then the raw flow behind it */}
              <Card className="mb-4 p-4" data-testid="ledger-summary-card">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-base font-semibold">{ledger.name}</h2>
                  <div className="flex items-center gap-2">
                    <Switch
                      id="loan-default-toggle"
                      data-testid="loan-default-toggle"
                      checked={ledger.loanDefault}
                      disabled={savingDefault}
                      onCheckedChange={(next) => void onToggleLoanDefault(next)}
                    />
                    <Label htmlFor="loan-default-toggle">
                      Treat untagged transfers as loans
                    </Label>
                  </div>
                </div>
                <div className="flex flex-wrap gap-8">
                  <div data-testid="loan-balance">
                    <div className="text-muted-foreground mb-1 text-xs uppercase tracking-wide">Loan balance</div>
                    {ledger.loanBalance.length === 0 ? (
                      <div className="text-sm text-muted-foreground">No tracked loans</div>
                    ) : (
                      ledger.loanBalance.map((b) => (
                        <div key={b.currency} className="text-lg font-semibold">
                          {formatBalanceLabel(b)}
                        </div>
                      ))
                    )}
                  </div>
                  <div data-testid="raw-net-flow">
                    <div className="text-muted-foreground mb-1 text-xs uppercase tracking-wide">
                      Raw transfer flow
                    </div>
                    {ledger.transferNet.length === 0 ? (
                      <div className="text-sm">—</div>
                    ) : (
                      ledger.transferNet.map((n) => (
                        <div key={n.currency} className="text-lg font-semibold">
                          {formatNetFlowLabel(n)}
                        </div>
                      ))
                    )}
                    <div className="mt-1 max-w-xs text-xs text-muted-foreground">
                      Everything that moved between you — not a debt.
                    </div>
                  </div>
                  <div data-testid="tracked-outstanding">
                    <div className="text-muted-foreground mb-1 text-xs uppercase tracking-wide">Tracked loans outstanding</div>
                    {Object.keys(ledger.trackedOutstandingByCurrency).length === 0 ? (
                      <div className="text-sm">—</div>
                    ) : (
                      Object.entries(ledger.trackedOutstandingByCurrency).map(([cur, amt]) => (
                        <div key={cur} className="text-lg font-semibold">
                          {cur} {Number(amt).toFixed(2)}
                        </div>
                      ))
                    )}
                  </div>
                </div>
                {mismatchCount > 0 && (
                  <div className="mt-3 text-xs text-muted-foreground" data-testid="mismatch-summary">
                    {mismatchCount === 1
                      ? '1 transfer is tagged against its direction. Direction wins.'
                      : `${mismatchCount} transfers are tagged against their direction. Direction wins.`}
                  </div>
                )}
                {/* Lent / repaid bar for this contact */}
                {ledger.loanBalance.length > 0 && (
                  <div className="mt-4 max-w-sm">
                    <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
                      Lent vs repaid
                    </div>
                    <LoanBar ledger={ledger} />
                  </div>
                )}
              </Card>

              {/* Transfer table */}
              <Card className="overflow-x-auto p-0">
                <Table data-testid="transfers-table">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Merchant</TableHead>
                      <TableHead>Amount</TableHead>
                      <TableHead>Direction</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead aria-label="actions" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {ledger.transfers.length === 0 ? (
                      <EmptyTableRow
                        colSpan={TRANSFER_COL_COUNT}
                        title="No transfers with this contact."
                        description="Import transactions or link a transfer to see them here."
                      />
                    ) : (
                      ledger.transfers.map((t) => (
                        <TableRow
                          key={t.id}
                          data-testid={`transfer-row-${t.id}`}
                          className={t.cancelled ? 'text-muted-foreground line-through' : undefined}
                          title={t.cancelled ? 'cancelled e-transfer pair' : undefined}
                        >
                          <TableCell>{t.date}</TableCell>
                          <TableCell>{t.merchant ?? '—'}</TableCell>
                          <TableCell>
                            {t.currency} {Number(t.amount).toFixed(2)}
                          </TableCell>
                          <TableCell>
                            <Badge variant={t.direction === 'out' ? 'outline' : 'secondary'}>
                              {t.direction === 'out' ? 'Out' : 'In'}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <div className="flex flex-col items-start gap-1">
                              <RoleSelect
                                txnId={t.id}
                                rowLabel={`${t.date} ${t.merchant ?? 'transfer'} ${t.currency} ${Number(t.amount).toFixed(2)}`}
                                value={t.counterpartyRole}
                                disabled={savingRole.has(t.id) || t.cancelled}
                                onChange={(role) => void onSetRole(t.id, role)}
                              />
                              {t.roleMismatch && (
                                <Badge variant="destructive" data-testid={`role-mismatch-${t.id}`}>
                                  tag disagrees with direction
                                </Badge>
                              )}
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="flex justify-end">
                              {t.direction === 'out' && !t.isLoan && !t.cancelled && (
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  onClick={() => onMarkLoan(t.id)}
                                >
                                  Mark as loan
                                </Button>
                              )}
                              {t.isLoan && (
                                <Badge variant="default">Loan</Badge>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </Card>
            </>
          ) : (
            <Card className="p-4">
              <div className="text-muted-foreground text-sm">Could not load ledger for this contact.</div>
            </Card>
          )}
        </>
      )}
    </div>
  )
}
