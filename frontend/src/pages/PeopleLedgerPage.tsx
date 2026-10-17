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
import { useEffect, useState, useCallback, useRef, type ReactNode } from 'react'
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
  InterestChargedStaleness,
  InterestWindowSummary,
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
  runInterestAllocation,
} from '../lib/api'
import {
  formatBalanceLabel,
  formatNetFlowLabel,
  buildOwedBreakdown,
  formatRateWindows,
  currentRateLabel,
  lastStatementDate,
  summarizeScaling,
  AMOUNT_FORMAT,
  type OwedBreakdown,
} from '../lib/peopleLedger'
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

/** The same, plus the Interest column, which only appears when someone has any. */
const LANDING_COL_COUNT_WITH_INTEREST = LANDING_COL_COUNT + 1

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

// ── Interest formatting ──────────────────────────────────────────────────────

/**
 * Grouped, code-prefixed money for the interest breakdown: `CAD 6,700.00`.
 *
 * The code goes in front rather than a locale symbol because this page is
 * multi-currency and never collapses to a primary one — `$174.80` next to
 * `$19.69` would not say whether they are the same currency. Uses the same
 * `AMOUNT_FORMAT` as `formatBalanceLabel` so the loan balance and the
 * interest breakdown — rendered side by side in the contact drill-in — group
 * thousands the same way instead of drifting.
 */
function amountLabel(currency: string, value: number): string {
  return `${currency} ${AMOUNT_FORMAT.format(value)}`
}

/**
 * Typography for a breakdown row, keyed rather than interpolated: Tailwind's
 * JIT only sees class names that appear as literal strings in the source.
 */
const FIGURE_LABEL_CLASS = {
  figure: 'text-sm text-muted-foreground',
  total: 'text-sm font-semibold',
} as const
const FIGURE_VALUE_CLASS = {
  figure: 'text-sm font-medium tabular-nums',
  total: 'text-base font-semibold tabular-nums',
} as const

type FigureTone = keyof typeof FIGURE_LABEL_CLASS

/** One line of the breakdown: label, figure, and the caption that sources it. */
function FigureRow({
  label,
  value,
  caption,
  tone = 'figure',
  badge,
  testId,
  captionTestId,
}: {
  label: string
  value: string
  caption: ReactNode
  tone?: FigureTone
  /** Rendered beside the figure — used to mark the accrued estimate. */
  badge?: ReactNode
  testId: string
  captionTestId?: string
}) {
  return (
    <div className="py-1" data-testid={testId}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <span className={FIGURE_LABEL_CLASS[tone]}>{label}</span>
        <span className="flex items-center gap-2">
          {badge}
          <span className={FIGURE_VALUE_CLASS[tone]}>{value}</span>
        </span>
      </div>
      <div className="mt-0.5 text-xs text-muted-foreground" data-testid={captionTestId}>
        {caption}
      </div>
    </div>
  )
}

/**
 * Principal, interest charged and interest accrued — three figures and a total,
 * never one merged number. See "Two figures, never merged" in
 * `docs/superpowers/specs/2026-09-15-loc-interest-attribution-design.md`.
 *
 * Renders NOTHING for a contact with no line-of-credit interest. Not `CAD 0.00`
 * — a zero here would read as "we computed this and it came to nothing", which
 * is a different and false claim from "this person has none".
 *
 * There is deliberately no repaid leg and no lent-vs-repaid bar: an interest
 * allocation's `repaid` is always `0.0000` because it is recomputed wholesale on
 * the next allocator run rather than paid down, so a bar drawn from it would
 * assert that none of it had been repaid.
 *
 * `rows.charged` comes from the STORED allocation; `windows` is a fresh
 * recomputation the same request happened to run. Nothing runs the allocator
 * automatically, so after a statement import the two disagree until someone
 * presses Reallocate — and captioning the stored figure with the live windows'
 * last date asserts coverage it does not have. `staleness` is the server's
 * comparison of the two, and every claim drawn from `windows` is gated on it.
 */
function OwedBreakdownCard({
  rows,
  windows,
  staleness,
}: {
  rows: OwedBreakdown[]
  windows: InterestWindowSummary[] | undefined
  staleness: InterestChargedStaleness | undefined
}) {
  if (rows.length === 0) return null
  const rateLine = formatRateWindows(windows)
  const rate = currentRateLabel(windows)
  const scaling = summarizeScaling(windows)
  const stale = staleness?.stale === true
  // What the STORED figure covers — never the newest window, which it may not
  // reach. An older server sends neither; then no through-date is claimed.
  const chargedThrough = staleness?.chargedThrough ?? null
  const statementThrough = staleness?.statementThrough ?? lastStatementDate(windows)
  const chargedCaption = stale
    ? [
        'Stale — press Reallocate.',
        chargedThrough
          ? `This is the last saved allocation, covering through ${chargedThrough}.`
          : 'This is the last saved allocation.',
        statementThrough
          ? `Statements are imported through ${statementThrough}; the days since are in neither figure below.`
          : '',
      ]
        .filter(Boolean)
        .join(' ')
    : chargedThrough
      ? `Apportioned from the interest RBC actually billed, through the ${chargedThrough} statement.`
      : 'Apportioned from the interest RBC actually billed.'
  // The gap only exists when a window's printed interest did NOT bind: the
  // scaling is one-directional, so allocations can fall short of the billed
  // figure and the difference is attributed to nobody.
  const unattributed = scaling ? scaling.billed - scaling.attributed : 0

  return (
    <div className="mt-4 border-t border-border pt-4" data-testid="owed-breakdown">
      <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
        Owed, broken out
      </div>
      <div className="flex flex-col gap-4">
        {rows.map((r) => (
          <div
            key={r.currency}
            className="max-w-lg"
            data-testid={`owed-breakdown-${r.currency}`}
          >
            {/* Principal may be absent while interest is not — the allocator
                only ever charges a positive balance, so that combination means
                something has gone wrong upstream. Say "unknown", never 0. */}
            <FigureRow
              testId={`owed-principal-${r.currency}`}
              label="Principal"
              value={
                r.principal === null
                  ? `${r.currency} unknown`
                  : amountLabel(r.currency, r.principal)
              }
              caption="Tagged loans, less what came back."
            />
            {r.charged !== null && (
              <FigureRow
                testId={`owed-charged-${r.currency}`}
                captionTestId={`owed-charged-caption-${r.currency}`}
                label="Interest charged"
                value={amountLabel(r.currency, r.charged)}
                badge={stale ? <Badge variant="outline">stale</Badge> : undefined}
                caption={chargedCaption}
              />
            )}
            {r.accrued !== null && (
              <FigureRow
                testId={`owed-accrued-${r.currency}`}
                captionTestId={`owed-accrued-caption-${r.currency}`}
                label="Interest accrued"
                value={amountLabel(r.currency, r.accrued)}
                badge={<Badge variant="outline">estimate</Badge>}
                caption={
                  // Named explicitly, not "that statement": this tail starts
                  // after the LAST IMPORTED window, which on a stale ledger is
                  // not where the charged figure above stopped.
                  `Estimated for the days since ${statementThrough ? `the ${statementThrough} statement` : 'the last statement'}${
                    rate ? `, at ${rate}` : ''
                  }. No document backs this figure — RBC has not billed it.`
                }
              />
            )}
            {r.total !== null && (
              <div className="mt-1 border-t border-border pt-1">
                <FigureRow
                  testId={`owed-total-${r.currency}`}
                  label="Total owed"
                  tone="total"
                  value={amountLabel(r.currency, r.total)}
                  badge={
                    r.totalIncludesEstimate ? <Badge variant="outline">part estimate</Badge> : undefined
                  }
                  caption={
                    stale
                      ? 'Principal plus the last saved interest allocation. That allocation is stale, so this total is incomplete.'
                      : r.totalIncludesEstimate
                        ? 'Principal plus charged interest plus the accrued estimate — part of this figure is not billed.'
                        : 'Principal plus charged interest. Every part of it billed.'
                  }
                />
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Nothing reallocates on import, so this is a normal state, not an
          error. It says what is out of date and what to press — never a
          confident figure over a period the stored rows do not cover. */}
      {stale && (
        <div className="mt-3 text-xs text-muted-foreground" data-testid="interest-stale">
          <span className="font-medium">Interest allocation is stale.</span>{' '}
          {staleness?.persistedTotal && staleness?.recomputedTotal
            ? `Saved ${staleness.persistedTotal}, a recomputation now gives ${staleness.recomputedTotal}.`
            : 'The saved allocation no longer matches the ledger.'}{' '}
          Press Reallocate interest to bring it up to date; until then the figures
          above cover less than the imported statements do.
        </div>
      )}

      {rateLine && (
        <div
          className="mt-3 text-xs text-muted-foreground"
          data-testid="interest-rate-windows"
        >
          <span className="font-medium">Rate windows:</span> {rateLine}
        </div>
      )}

      {/* The bound is the check, not padding. It binds in most windows because
          total lending exceeds the line — expected, not a fault — but a sudden
          change in it means the lending or the line moved, so it is shown.
          These numbers describe the FRESH recomputation, so on a stale ledger
          they are said to be what a reallocation WOULD do, not what is stored. */}
      {scaling && (
        <div className="mt-1 text-xs text-muted-foreground" data-testid="interest-scaling">
          {stale ? 'A recomputation, not yet saved: scaled' : 'Scaled'} to the statement in{' '}
          {scaling.bound} of {scaling.active} windows that allocated anything; smallest
          factor {scaling.minFactor.toFixed(3)}. Lending exceeds the line, so each
          window&apos;s shares are scaled down to the interest RBC printed for it.
        </div>
      )}

      {/* The bound only scales DOWN. When it does not bind, the window's
          allocations fall short of the printed figure and the residue belongs to
          nobody — 23% of the billed interest on the real data, which the ratio
          alone hid behind a confident "Interest charged" total. */}
      {scaling && unattributed > 0.005 && (
        <div className="mt-1 text-xs text-muted-foreground" data-testid="interest-attribution-gap">
          Attributed {AMOUNT_FORMAT.format(scaling.attributed)} of the{' '}
          {AMOUNT_FORMAT.format(scaling.billed)} RBC billed across every rate window;{' '}
          {AMOUNT_FORMAT.format(unattributed)} is attributed to nobody — mostly windows
          that predate any tagged lending.
        </div>
      )}
    </div>
  )
}

/** What a currency's debts add up to, in each direction. Never netted. */
interface CurrencyTotals {
  /** Sum of the positive balances — what people owe you. */
  owedToYou: number
  /** Sum of the negative balances, as a positive number — what you owe. */
  youOwe: number
}

/**
 * A currency's interest, kept in its two halves. Charged is billed and traces
 * to a statement; accrued is estimated and traces to nothing. Adding them would
 * produce a number half of which is invented and no way to tell which half.
 */
interface InterestTotals {
  charged: number
  accrued: number
}

/**
 * Money scale for accumulation: integers of 1/10_000 of a currency unit.
 *
 * Matches `computeLoanBalance` and `computeTransferNet` on the backend, which
 * both fold at this scale and emit fixed-4 strings. Summing those strings back
 * as floats and mopping up with a cents round afterwards was wrong twice over:
 * the residue is only invisible until enough contacts are loaded, and a cents
 * round destroys sub-cent balances outright — several contacts each owing a
 * fraction of a cent totalled to exactly 0 and the tile then showed nothing
 * outstanding over live debts.
 */
const MONEY_SCALE = 10_000

/** A fixed-4 decimal amount as an exact integer count of 1/10_000 units. */
function toMoneyUnits(n: number): number {
  return Math.round(n * MONEY_SCALE)
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
 * Contacts whose ledger failed to load contribute nothing here — an absent
 * ledger is not a zero balance. That makes these totals a floor, not a sum,
 * and the returned map cannot tell "nobody owes anything" apart from "nothing
 * could be loaded". Callers MUST therefore pair the result with
 * `failedLedgerIds` before wording anything, and must not render an empty map
 * as "Nothing outstanding" while a fetch is unaccounted for. The metrics card
 * below does exactly that.
 */
function deriveMetrics(cwl: ContactWithLedger[]): {
  balanceByCurrency: Map<string, CurrencyTotals>
  interestByCurrency: Map<string, InterestTotals>
  trackedLoansCount: number
} {
  const balanceByCurrency = new Map<string, CurrencyTotals>()
  const interestByCurrency = new Map<string, InterestTotals>()
  // Accumulated in whole `MONEY_SCALE` units; converted back exactly at the end.
  const unitsByCurrency = new Map<string, CurrencyTotals>()
  const interestUnits = new Map<string, InterestTotals>()
  let trackedLoansCount = 0
  const seen = new Set<number>()
  for (const { contact, ledger } of cwl) {
    if (contact.isSelf || contact.isPartner || !ledger) continue
    // Charged and accrued accumulate separately and are NEVER summed here:
    // one is billed and one is estimated, and a single "interest" headline
    // would make the estimate indistinguishable from the fact.
    for (const r of buildOwedBreakdown(ledger)) {
      const t = interestUnits.get(r.currency) ?? { charged: 0, accrued: 0 }
      if (r.charged !== null) t.charged += toMoneyUnits(r.charged)
      if (r.accrued !== null) t.accrued += toMoneyUnits(r.accrued)
      interestUnits.set(r.currency, t)
    }
    for (const b of ledger.loanBalance) {
      const v = Number(b.balance)
      if (!Number.isFinite(v)) continue
      const units = toMoneyUnits(v)
      if (units === 0) continue
      const totals = unitsByCurrency.get(b.currency) ?? { owedToYou: 0, youOwe: 0 }
      if (units > 0) totals.owedToYou += units
      else totals.youOwe += -units
      unitsByCurrency.set(b.currency, totals)
    }
    const loanCount = Object.keys(ledger.trackedOutstandingByCurrency).filter(
      (cur) => Number(ledger.trackedOutstandingByCurrency[cur]) > 0,
    ).length
    if (loanCount > 0 && !seen.has(contact.id)) {
      seen.add(contact.id)
      trackedLoansCount++
    }
  }
  for (const [currency, t] of unitsByCurrency) {
    // Exact: an integer divided by the scale it was built at. No residue to
    // round away, and a sub-cent total survives to be shown rather than being
    // rounded to 0 and dropped by the `> 0` gate on the tile.
    balanceByCurrency.set(currency, {
      owedToYou: t.owedToYou / MONEY_SCALE,
      youOwe: t.youOwe / MONEY_SCALE,
    })
  }
  for (const [currency, t] of interestUnits) {
    interestByCurrency.set(currency, {
      charged: t.charged / MONEY_SCALE,
      accrued: t.accrued / MONEY_SCALE,
    })
  }
  return { balanceByCurrency, interestByCurrency, trackedLoansCount }
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

// ── TileCaption ──────────────────────────────────────────────────────────────

/**
 * The small print under a number. This page shows two debt-shaped figures side
 * by side — the signed `loanBalance` and the older `trackedOutstanding` — and
 * in production they disagree. Without a caption the reader has to guess which
 * one answers "what do they owe me", so every one of them says what it is.
 */
function TileCaption({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div className="mt-1 max-w-xs text-xs text-muted-foreground" data-testid={testId}>
      {children}
    </div>
  )
}

/**
 * What `trackedOutstandingByCurrency` actually is, in one sentence. It is the
 * sum of this contact's Reimbursement rows still expected or overdue — claims
 * logged by hand. It never reads `counterparty_role`, so it is not the same
 * quantity as `loanBalance` and is not expected to agree with it.
 */
const TRACKED_OUTSTANDING_CAPTION =
  'Unpaid reimbursement claims you logged by hand. A separate, older tally that ignores transfer tags — the loan balance is this page’s answer to what they owe you.'

/** The landing column's shorter form of the same disclaimer. */
const TRACKED_OUTSTANDING_COLUMN_CAPTION =
  'Hand-logged reimbursement claims — not the loan balance'

/**
 * What `loanBalance` is — which depends on the contact's `loanDefault`.
 *
 * With it off, only rows carrying a loan/repayment tag are folded in. With it
 * on, `resolveLedgerRole` also folds in every UNTAGGED row by direction, which
 * on the real Evan and Caelan data is most of the balance. A single fixed
 * sentence was therefore false half the time, and worse than useless with the
 * toggle sitting twenty pixels above it: the reader flips it, watches the
 * number move, and reads a caption saying it shouldn't have.
 */
function loanBalanceCaption(loanDefault: boolean): string {
  return loanDefault
    ? 'What they owe you: every transfer tagged loan or repayment, PLUS every untagged transfer counted by its direction — because the toggle above is on. This page’s answer.'
    : 'What they owe you: every transfer tagged loan or repayment, netted. Untagged transfers are not counted. This page’s answer.'
}

/**
 * The landing column's shorter form. This header stands over every contact at
 * once and `loanDefault` is per-contact, so no single sentence can describe the
 * state of the column — the contacts in it disagree. It states the RULE
 * instead, which is true of every row regardless of how each toggle is set;
 * the per-contact drill-in caption is where the current state is stated.
 */
const LOAN_BALANCE_COLUMN_CAPTION =
  'What they owe you — tagged transfers, plus untagged ones for contacts set to treat untagged as loans'

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
  const [allocatingInterest, setAllocatingInterest] = useState(false)

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
   * Refetch the ledger. Required after any write that changes the balance: the
   * balance is recomputed server-side from every row at once, so no local patch
   * of the written row can produce it. The server is the only thing that knows
   * what the write did to the total.
   *
   * Deliberately does NOT raise `ledgerLoading` — that swaps the whole card and
   * table for "Loading…", and with a role dropdown on every row it would blink
   * the table away on each tag. The control that was used is disabled for the
   * duration instead (`savingRole` / `savingDefault`), which is the localised
   * affordance; a failed refetch leaves the previous ledger on screen.
   *
   * It does, however, have to LOWER `ledgerLoading`. Taking the token orphans
   * any navigation fetch still in flight, and that fetch's `finally` only
   * clears the flag while it is still current — so whoever took the token owns
   * the flag from then on. Without this, a reload racing the initial fetch
   * (reachable from "Link transfers", whose button renders outside the loading
   * gate) pins the drill-in to "Loading…" over a ledger that is right there.
   * The clear is itself token-guarded: if a newer navigation has since taken
   * over, that effect is mid-fetch and will clear the flag when it lands.
   */
  const reload = useCallback(async () => {
    if (selectedId == null) return
    const token = ++ledgerRequestRef.current
    try {
      const data = await getContactLedger(selectedId)
      // Discard if the user navigated away or a newer refetch superseded us.
      if (token === ledgerRequestRef.current) setLedger(data)
    } catch {
      // `reload` only ever runs AFTER a write has succeeded, so nothing else
      // has toasted — the write's own catch was never entered. Silence here
      // leaves the pre-write balance on screen under "What they owe you", the
      // role dropdown snapped back and the loanDefault Switch visibly
      // reverted, all while the server holds the new value. Say so; the stale
      // ledger stays on screen because it is still the last thing we know.
      if (token === ledgerRequestRef.current) {
        showToastRef.current({
          title: 'Saved, but the balance couldn’t be refreshed.',
          variant: 'destructive',
        })
      }
    } finally {
      if (token === ledgerRequestRef.current) setLedgerLoading(false)
    }
  }, [selectedId])

  // ── Drill-in actions ──────────────────────────────────────────────────────

  async function onMarkLoan(txnId: number) {
    if (selectedId == null) return
    try {
      await markTransactionAsLoan(txnId, selectedId)
      showToastRef.current({ title: 'Reimbursement claim logged', variant: 'success' })
      await reload()
    } catch (e) {
      showToastRef.current({ title: e instanceof Error ? e.message : 'Update failed', variant: 'destructive' })
    }
  }

  async function onSetRole(txnId: number, role: CounterpartyRole | null) {
    setSavingRole((prev) => new Set([...prev, txnId]))
    try {
      await setCounterpartyRole(txnId, role)
      // The PATCH does echo the saved row back, but the balance this row feeds
      // is folded server-side across every row at once — no local edit of one
      // row can produce it. The ledger is the only source of truth for what the
      // tag did to the total, so refetch instead of patching state.
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

  /**
   * Recompute the charged allocation, then reload everything that shows it.
   *
   * Household-wide by construction: each rate window's printed interest is
   * apportioned across every borrower at once, so the landing list is as stale
   * afterwards as the open drill-in and both are refetched. The accrued
   * estimate is not stored and so is not "reallocated" — it is recomputed on
   * every ledger read regardless, which is why the button says nothing about it.
   */
  async function onReallocateInterest() {
    setAllocatingInterest(true)
    try {
      const r = await runInterestAllocation()
      showToastRef.current({
        title: `Interest reallocated: ${r.allocations} across ${r.windows} rate windows`,
        variant: 'success',
      })
      await Promise.all([reload(), loadAll()])
    } catch (e) {
      showToastRef.current({
        title: e instanceof Error ? e.message : 'Reallocation failed',
        variant: 'destructive',
      })
    } finally {
      setAllocatingInterest(false)
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
  const { balanceByCurrency, interestByCurrency, trackedLoansCount } = deriveMetrics(cwl)
  const interestEntries = [...interestByCurrency.entries()]
    .filter(([, t]) => t.charged > 0 || t.accrued > 0)
    .sort(([a], [b]) => a.localeCompare(b))
  // Per-contact interest for the landing list, and the gate on the column
  // existing at all: nobody with interest, no column — not a column of zeros.
  const interestByContact = new Map<number, OwedBreakdown[]>(
    cwl.map(({ contact, ledger: l }) => [contact.id, buildOwedBreakdown(l)]),
  )
  const anyInterest = [...interestByContact.values()].some((rows) => rows.length > 0)
  const landingColCount = anyInterest ? LANDING_COL_COUNT_WITH_INTEREST : LANDING_COL_COUNT
  // Drop any currency whose two sides both rounded away to zero, so the
  // "Nothing outstanding" fallback below can't be skipped by an empty entry.
  const balanceEntries = [...balanceByCurrency.entries()]
    .filter(([, t]) => t.owedToYou > 0 || t.youOwe > 0)
    .sort(([a], [b]) => a.localeCompare(b))
  const mismatchCount = countMismatches(ledger)

  // How much of the headline the page is actually entitled to claim.
  // `balanceEntries` is built only from ledgers that loaded, so on its own an
  // empty array is ambiguous: it means "no debt" only when nothing failed.
  const failedCount = realContacts.filter((c) => failedLedgerIds.has(c.id)).length
  /** Nothing loaded at all — there is no total to show, only an apology. */
  const allBalancesUnknown = realContacts.length > 0 && failedCount === realContacts.length
  /** Some loaded, some didn't: show what we have, labelled as partial. */
  const balancesIncomplete = failedCount > 0

  const failedContactsPhrase =
    failedCount === 1 ? "1 contact's balance" : `${failedCount} contacts' balances`

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
            variant="outline"
            size="sm"
            data-testid="reallocate-interest"
            disabled={allocatingInterest}
            title="Recomputes each rate window's share of the interest RBC billed, across every borrower. The accrued estimate is not stored and is recomputed on every read."
            onClick={onReallocateInterest}
          >
            {allocatingInterest ? 'Reallocating…' : 'Reallocate interest'}
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
                {allBalancesUnknown ? (
                  // Every ledger fetch failed. A total here would be a total of
                  // nothing, and "Nothing outstanding" would assert zero debt
                  // over N balances nobody has seen.
                  <MetricCard label="Loan balance" value="Couldn't load" />
                ) : balanceEntries.length === 0 ? (
                  <MetricCard
                    label="Loan balance"
                    value={balancesIncomplete ? 'Incomplete' : 'Nothing outstanding'}
                  />
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
                {/* Interest keeps its own tiles, and keeps them apart from each
                    other. Folding interest into the balance would hide which
                    half of a rising total moved; folding the estimate into the
                    charged figure would hide that half of it is not billed. */}
                {interestEntries.flatMap(([currency, t]) => {
                  const cards = []
                  if (t.charged > 0) {
                    cards.push(
                      <MetricCard
                        key={`${currency}-interest-charged`}
                        label={`Interest charged · ${currency}`}
                        value={amountLabel(currency, t.charged)}
                      />,
                    )
                  }
                  if (t.accrued > 0) {
                    cards.push(
                      <MetricCard
                        key={`${currency}-interest-accrued`}
                        label={`Interest accrued (estimate) · ${currency}`}
                        value={amountLabel(currency, t.accrued)}
                      />,
                    )
                  }
                  return cards
                })}
                <MetricCard
                  label="People"
                  value={realContacts.length}
                />
                <MetricCard
                  label="Tracked loans"
                  // Also derived from the ledgers, so it is also unknown when
                  // none of them loaded. A bare 0 would read as "none".
                  value={allBalancesUnknown ? '—' : trackedLoansCount}
                />
                <MetricCard
                  label="Flagged to exclude"
                  value={selfContacts.length + selfSuggestions.length}
                />
              </div>
              {balancesIncomplete && (
                <div
                  className="mt-3 text-xs text-muted-foreground"
                  data-testid="metrics-incomplete"
                >
                  Incomplete: {failedContactsPhrase} couldn&apos;t be loaded, so these
                  totals are a floor, not the whole picture.
                </div>
              )}
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
                  {/* Three money columns, two of which look like debts. Each
                      carries its own one-liner so the reader never has to
                      guess which one answers "what do they owe me". */}
                  <TableHead>
                    <div className="flex flex-col gap-0.5">
                      <span>Loan balance</span>
                      <span
                        className="text-xs font-normal normal-case text-muted-foreground"
                        data-testid="loan-balance-column-caption"
                      >
                        {LOAN_BALANCE_COLUMN_CAPTION}
                      </span>
                    </div>
                  </TableHead>
                  {/* Beside the balance, never inside it. The column only
                      exists when somebody carries interest — a column of
                      dashes over a household with no line of credit would
                      imply a figure that was computed and came to nothing. */}
                  {anyInterest && (
                    <TableHead>
                      <div className="flex flex-col gap-0.5">
                        <span>Interest</span>
                        <span
                          className="text-xs font-normal normal-case text-muted-foreground"
                          data-testid="interest-column-caption"
                        >
                          Line-of-credit interest, charged plus estimated — not part of the balance
                        </span>
                      </div>
                    </TableHead>
                  )}
                  <TableHead>
                    <div className="flex flex-col gap-0.5">
                      <span>Raw transfer flow</span>
                      <span className="text-xs font-normal normal-case text-muted-foreground">
                        Everything that moved — not a debt
                      </span>
                    </div>
                  </TableHead>
                  <TableHead>
                    <div className="flex flex-col gap-0.5">
                      <span>Outstanding loans</span>
                      <span
                        className="text-xs font-normal normal-case text-muted-foreground"
                        data-testid="outstanding-loans-caption"
                      >
                        {TRACKED_OUTSTANDING_COLUMN_CAPTION}
                      </span>
                    </div>
                  </TableHead>
                  <TableHead>Lent vs repaid</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {contactsLoading || ledgersLoading ? (
                  Array.from({ length: 3 }).map((_, i) => (
                    <SkeletonRow key={`people-skel-${i}`} cols={landingColCount} />
                  ))
                ) : sortedContacts.length === 0 ? (
                  <EmptyTableRow
                    colSpan={landingColCount}
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
                        {anyInterest && (
                          <TableCell data-testid={`interest-cell-${c.id}`}>
                            {(() => {
                              // A failed fetch leaves this contact out of the
                              // ledger map, so the breakdown comes back empty —
                              // indistinguishable from "has none" unless the
                              // failure is checked FIRST, exactly as the Balance
                              // cell two columns left does.
                              if (failedLedgerIds.has(c.id)) {
                                return (
                                  <span className="text-sm text-muted-foreground">
                                    Couldn&apos;t load
                                  </span>
                                )
                              }
                              const rows = interestByContact.get(c.id) ?? []
                              if (rows.length === 0) {
                                // This contact has none. Not zero — none.
                                return <span className="text-sm text-muted-foreground">—</span>
                              }
                              return (
                                <div
                                  className="flex flex-col gap-0.5"
                                  data-testid={`interest-${c.id}`}
                                >
                                  {rows.map((r) => (
                                    <span key={r.currency} className="text-sm font-medium">
                                      + {amountLabel(r.currency, (r.charged ?? 0) + (r.accrued ?? 0))}
                                      {r.accrued !== null && (
                                        <span className="ml-1 font-normal text-muted-foreground">
                                          incl. estimate
                                        </span>
                                      )}
                                    </span>
                                  ))}
                                </div>
                              )
                            })()}
                          </TableCell>
                        )}
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
                    <TileCaption testId="loan-balance-caption">
                      {loanBalanceCaption(ledger.loanDefault)}
                    </TileCaption>
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
                    <TileCaption testId="raw-net-flow-caption">
                      Everything that moved between you — not a debt.
                    </TileCaption>
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
                    <TileCaption testId="tracked-outstanding-caption">
                      {TRACKED_OUTSTANDING_CAPTION}
                    </TileCaption>
                  </div>
                </div>
                {mismatchCount > 0 && (
                  <div className="mt-3 text-xs text-muted-foreground" data-testid="mismatch-summary">
                    {mismatchCount === 1
                      ? '1 transfer is tagged against its direction. Direction wins.'
                      : `${mismatchCount} transfers are tagged against their direction. Direction wins.`}
                  </div>
                )}
                {/* Lent / repaid bar for this contact. Gated on there being a
                    segment to draw, not on the balance being non-empty:
                    `computeBarSegments` skips any currency with nothing lent,
                    and a repaid-only row (Stephen's real USD leg — lent 0,
                    repaid 3570.51) would otherwise leave this heading standing
                    over an empty box. */}
                {computeBarSegments(ledger).length > 0 && (
                  <div className="mt-4 max-w-sm">
                    <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
                      Lent vs repaid
                    </div>
                    <LoanBar ledger={ledger} />
                  </div>
                )}
                {/* The bar above is principal only, deliberately: an interest
                    allocation's `repaid` is always zero, so including it would
                    draw a bar asserting none of it had been repaid. */}
                <OwedBreakdownCard
                  rows={buildOwedBreakdown(ledger)}
                  windows={ledger.interestWindows}
                  staleness={ledger.interestStaleness}
                />
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
                              {/* This posts a Reimbursement, which moves
                                  "Tracked loans outstanding" and NOTHING else.
                                  It used to read "Mark as loan", one cell from
                                  a Role dropdown whose "Loan" option moves the
                                  loan balance instead — two controls with the
                                  same name moving two numbers that disagree in
                                  production. The label and the tooltip now say
                                  which tile each one is for. */}
                              {t.direction === 'out' && !t.isLoan && !t.cancelled && (
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  data-testid={`log-claim-${t.id}`}
                                  title="Logs a reimbursement claim — moves “Tracked loans outstanding”. To change the loan balance, use the Role dropdown."
                                  onClick={() => onMarkLoan(t.id)}
                                >
                                  Log reimbursement claim
                                </Button>
                              )}
                              {t.isLoan && (
                                <Badge variant="default">Claim logged</Badge>
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
