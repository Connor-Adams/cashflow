/**
 * Renders the "why" beneath an insight's description — the evidence the
 * detector actually reasoned from, pulled out of the insight's `metadata`
 * column. Pure presentation: no new detection logic, no new derived
 * numbers beyond simple display arithmetic (a delta, a percentage already
 * present in metadata).
 *
 * `metadata` is untrusted: these rows come straight from the DB and older
 * rows may predate a metadata shape, or belong to a type this component
 * doesn't know about. Every parser below validates before reading, and
 * `InsightEvidence` wraps the whole render in a try/catch — an unknown
 * type or malformed metadata renders nothing, never throws.
 *
 * Shapes are sourced from (and must stay in sync with):
 *   - backend/src/insights/detectors/index.ts (the 8 detector types)
 *   - backend/src/subscriptions/detectSubscriptionPriceChanges.ts
 *     (subscription_price_increase's own open-insight metadata)
 *   - backend/src/pages/MoneyLeaksPage.tsx's dismiss snapshot (the 4
 *     money-leak types, plus the alternate dismissed-leak shape that
 *     subscription_price_increase can also carry once dismissed via the
 *     money-leaks flow — GET /api/insights has no entityType filter, so
 *     both shapes for that type can reach this page).
 *
 * `.superpowers/sdd/detector-metadata-enrichment.md` documents a second,
 * additive wave of fields on top of the above: `priorMonths` (the actual
 * per-month comparison baseline, not just its average), capped
 * contributing-transaction id lists with a `*Total` count, and a
 * `threshold` echo of the constant that fired. All of it is OPTIONAL —
 * ~153 production rows were written before this wave and will keep the
 * old shape until the detectors next run, so every renderer below falls
 * back to its pre-enrichment rendering when the new fields are absent.
 */
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Sparkline } from '@connor-adams/designsystem'
import { formatMoney } from '@/lib/formatMoney'

// ---- generic metadata guards --------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

function isIntegerArray(v: unknown): v is number[] {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((x) => typeof x === 'number' && Number.isInteger(x))
  )
}

function isFiniteNumberArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.length > 0 && v.every(isFiniteNumber)
}

function txnHref(id: number): string {
  return `/transactions?ids=${id}`
}

/** Validates every key of `v` is present and a finite number, returning a
 *  fully-typed object or `null` — used for the various `threshold` shapes,
 *  which are optional and untrusted like everything else in `metadata`. */
function pickFiniteNumbers<K extends string>(v: unknown, keys: readonly K[]): Record<K, number> | null {
  if (!isRecord(v)) return null
  const out = {} as Record<K, number>
  for (const key of keys) {
    const val = v[key]
    if (!isFiniteNumber(val)) return null
    out[key] = val
  }
  return out
}

// ---- prior-months comparison trail ---------------------------------------
// Shared by every detector that now carries `priorMonths` (spike, category
// spike, recurring increase): a `{ month: 'YYYY-MM', amount }[]`, ascending.
// Rendering every month in the trail — rather than collapsing to an average
// — is the point: a 1-entry trail visibly reads as "one prior month", where
// the old `$X/mo avg` phrasing made a single-month baseline look like a
// settled average.

type MonthAmount = { month: string; amount: number }

function isMonthKey(v: unknown): v is string {
  return isNonEmptyString(v) && /^\d{4}-\d{2}$/.test(v)
}

function isMonthAmountArray(v: unknown): v is MonthAmount[] {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((x) => isRecord(x) && isMonthKey(x.month) && isFiniteNumber(x.amount))
  )
}

function shortMonthLabel(monthKey: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey)
  if (!match) return monthKey
  const year = Number(match[1])
  const month = Number(match[2])
  const d = new Date(Date.UTC(year, month - 1, 1))
  return d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })
}

function monthTrailText(
  priorMonths: MonthAmount[],
  currentMonth: string | null,
  currentAmount: number,
  currency: string,
): string {
  const parts = priorMonths.map((pm) => `${shortMonthLabel(pm.month)} ${formatMoney(pm.amount, currency)}`)
  if (currentMonth) {
    parts.push(`${shortMonthLabel(currentMonth)} ${formatMoney(currentAmount, currency)}`)
  }
  return parts.join(' → ')
}

function MonthTrailLine({
  priorMonths,
  currentMonth,
  currentAmount,
  currency,
}: {
  priorMonths: MonthAmount[]
  currentMonth: string | null
  currentAmount: number
  currency: string
}): ReactNode {
  const singlePriorMonth = priorMonths.length === 1
  return (
    <p className="mt-1 text-xs text-muted-foreground">
      {monthTrailText(priorMonths, currentMonth, currentAmount, currency)}
      {singlePriorMonth ? (
        <span className="text-muted-foreground/70"> · based on 1 prior month</span>
      ) : null}
    </p>
  )
}

// ---- shared layout bits --------------------------------------------------

function EvidenceLine({ children }: { children: ReactNode }) {
  return <p className="mt-1 text-xs text-muted-foreground">{children}</p>
}

/** The threshold-in-plain-language footnote (item 3 of the evidence spec):
 *  visually subordinate to the numbers above it — one short line, muted
 *  further than the regular evidence text. */
function ThresholdNote({ children }: { children: ReactNode }) {
  return <p className="mt-1 text-[11px] text-muted-foreground/70">{children}</p>
}

/** A collapsed-by-default disclosure, matching the `<details>` pattern used
 *  elsewhere in the app (e.g. ReceiptsList) rather than a heavier
 *  stateful component — this can render 140+ times on one page. */
function EvidenceDetails({
  summary,
  children,
}: {
  summary: ReactNode
  children: ReactNode
}) {
  return (
    <details className="group mt-1">
      <summary className="cursor-pointer list-none text-xs text-muted-foreground underline-offset-4 hover:underline [&::-webkit-details-marker]:hidden">
        {summary}
      </summary>
      <ul className="mt-1 flex flex-col gap-0.5 border-l border-border pl-3">
        {children}
      </ul>
    </details>
  )
}

/** Label for a capped contributing-id list's `<details>` summary — uses the
 *  true `*Total` count (not the capped array length) so a capped list never
 *  undercounts what it's summarizing. */
function cappedCountLabel(ids: number[], total: number | null, noun: string): string {
  const n = total ?? ids.length
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

/** The contributing-transaction `<li>` links themselves, plus a trailing
 *  "and N more" row when `total` exceeds the (capped-at-20) `ids` array —
 *  surfacing the cap rather than silently truncating it. */
function TransactionLinks({ ids, total }: { ids: number[]; total: number | null }): ReactNode {
  const extra = total != null && total > ids.length ? total - ids.length : 0
  return (
    <>
      {ids.map((id) => (
        <li key={id}>
          <Link
            to={txnHref(id)}
            className="text-xs text-primary underline-offset-4 hover:underline"
          >
            Transaction #{id}
          </Link>
        </li>
      ))}
      {extra > 0 ? <li className="text-xs text-muted-foreground">and {extra} more</li> : null}
    </>
  )
}

// ---- duplicate_transactions -----------------------------------------------

type DuplicateTxnRow = { id: number; date: string; amount: number }

function isDuplicateTxnRow(v: unknown): v is DuplicateTxnRow {
  return (
    isRecord(v) &&
    typeof v.id === 'number' &&
    Number.isInteger(v.id) &&
    isNonEmptyString(v.date) &&
    isFiniteNumber(v.amount)
  )
}

function isDuplicateTxnRowArray(v: unknown): v is DuplicateTxnRow[] {
  return Array.isArray(v) && v.length > 0 && v.every(isDuplicateTxnRow)
}

type DuplicateTransactionsMeta = {
  transactionIds: number[]
  merchant: string
  amount: number
  currency: string
  transactions: DuplicateTxnRow[] | null
  threshold: { windowDays: number } | null
}

function parseDuplicateTransactions(m: unknown): DuplicateTransactionsMeta | null {
  if (!isRecord(m)) return null
  const { transactionIds, merchant, amount, currency, transactions, threshold } = m
  if (!isIntegerArray(transactionIds)) return null
  if (!isNonEmptyString(merchant)) return null
  if (!isFiniteNumber(amount)) return null
  if (!isNonEmptyString(currency)) return null
  return {
    transactionIds,
    merchant,
    amount,
    currency,
    transactions: isDuplicateTxnRowArray(transactions) ? transactions : null,
    threshold: pickFiniteNumbers(threshold, ['windowDays']),
  }
}

function renderDuplicateTransactions(metadata: unknown): ReactNode | null {
  const m = parseDuplicateTransactions(metadata)
  if (!m) return null
  const total = m.amount * m.transactionIds.length
  return (
    <>
      <EvidenceDetails
        summary={`${m.transactionIds.length} matched charges of ${formatMoney(m.amount, m.currency)} each · total ${formatMoney(total, m.currency)}`}
      >
        {m.transactions
          ? // Judging a duplicate means seeing the rows themselves, not just
            // their ids — date + amount each.
            m.transactions.map((row) => (
              <li key={row.id}>
                <Link
                  to={txnHref(row.id)}
                  className="text-xs text-primary underline-offset-4 hover:underline"
                >
                  {row.date} · {formatMoney(row.amount, m.currency)}
                </Link>
              </li>
            ))
          : // OLD SHAPE fallback — pre-enrichment rows only have bare ids.
            m.transactionIds.map((id) => (
              <li key={id}>
                <Link
                  to={txnHref(id)}
                  className="text-xs text-primary underline-offset-4 hover:underline"
                >
                  Transaction #{id}
                </Link>
              </li>
            ))}
      </EvidenceDetails>
      {m.threshold ? (
        <ThresholdNote>Flagged because the charges matched within {m.threshold.windowDays} days.</ThresholdNote>
      ) : null}
    </>
  )
}

// ---- merchant_spend_spike / unusual_category_spend ------------------------
// Same shape (a subject + current-vs-prior-average pair), different label.

type SpikeLikeMeta = {
  subject: string
  currency: string
  currentAmount: number
  priorAvg: number
  multiplier: number | null
  currentMonth: string | null
  priorMonths: MonthAmount[] | null
  currentIds: number[] | null
  currentIdsTotal: number | null
  threshold: { multiplier: number; minCurrent: number } | null
}

function parseSpikeLike(m: unknown, subjectKey: 'merchant' | 'category'): SpikeLikeMeta | null {
  if (!isRecord(m)) return null
  const subject = m[subjectKey]
  const { currency, currentAmount, priorAvg, multiplier, currentMonth, priorMonths, currentIds, currentIdsTotal, threshold } = m
  if (!isNonEmptyString(subject)) return null
  if (!isNonEmptyString(currency)) return null
  if (!isFiniteNumber(currentAmount)) return null
  if (!isFiniteNumber(priorAvg)) return null
  return {
    subject,
    currency,
    currentAmount,
    priorAvg,
    multiplier: isFiniteNumber(multiplier) ? multiplier : null,
    currentMonth: isMonthKey(currentMonth) ? currentMonth : null,
    priorMonths: isMonthAmountArray(priorMonths) ? priorMonths : null,
    currentIds: isIntegerArray(currentIds) ? currentIds : null,
    currentIdsTotal: isFiniteNumber(currentIdsTotal) ? currentIdsTotal : null,
    threshold: pickFiniteNumbers(threshold, ['multiplier', 'minCurrent']),
  }
}

function renderSpikeLike(m: SpikeLikeMeta): ReactNode {
  if (!m.priorMonths) {
    // OLD SHAPE fallback — pre-enrichment rows only have the averaged
    // priorAvg, not the actual per-month breakdown. Render exactly what
    // this component always rendered for them.
    const delta = m.currentAmount - m.priorAvg
    return (
      <EvidenceLine>
        {formatMoney(m.priorAvg, m.currency)}/mo avg → {formatMoney(m.currentAmount, m.currency)} this
        month (+{formatMoney(delta, m.currency)}
        {m.multiplier != null ? `, ${m.multiplier.toFixed(1)}×` : ''})
      </EvidenceLine>
    )
  }
  return (
    <>
      <MonthTrailLine
        priorMonths={m.priorMonths}
        currentMonth={m.currentMonth}
        currentAmount={m.currentAmount}
        currency={m.currency}
      />
      {m.currentIds ? (
        <EvidenceDetails
          summary={cappedCountLabel(m.currentIds, m.currentIdsTotal, 'contributing transaction')}
        >
          <TransactionLinks ids={m.currentIds} total={m.currentIdsTotal} />
        </EvidenceDetails>
      ) : null}
      {m.threshold ? (
        <ThresholdNote>
          Flagged because this month is over {m.threshold.multiplier}× the prior average and above{' '}
          {formatMoney(m.threshold.minCurrent, m.currency)}.
        </ThresholdNote>
      ) : null}
    </>
  )
}

function renderMerchantSpendSpike(metadata: unknown): ReactNode | null {
  const m = parseSpikeLike(metadata, 'merchant')
  return m ? renderSpikeLike(m) : null
}

function renderUnusualCategorySpend(metadata: unknown): ReactNode | null {
  const m = parseSpikeLike(metadata, 'category')
  return m ? renderSpikeLike(m) : null
}

// ---- recurring_increase ----------------------------------------------------

type RecurringIncreaseMeta = {
  merchant: string
  currency: string
  priorAmount: number
  currentAmount: number
  currentMonth: string | null
  priorMonths: MonthAmount[] | null
  supportingTransactionIds: number[] | null
  supportingTransactionIdsTotal: number | null
  threshold: { ratio: number } | null
}

function parseRecurringIncrease(m: unknown): RecurringIncreaseMeta | null {
  if (!isRecord(m)) return null
  const {
    merchant,
    currency,
    priorAmount,
    currentAmount,
    currentMonth,
    priorMonths,
    supportingTransactionIds,
    supportingTransactionIdsTotal,
    threshold,
  } = m
  if (!isNonEmptyString(merchant)) return null
  if (!isNonEmptyString(currency)) return null
  if (!isFiniteNumber(priorAmount)) return null
  if (!isFiniteNumber(currentAmount)) return null
  return {
    merchant,
    currency,
    priorAmount,
    currentAmount,
    currentMonth: isMonthKey(currentMonth) ? currentMonth : null,
    priorMonths: isMonthAmountArray(priorMonths) ? priorMonths : null,
    supportingTransactionIds: isIntegerArray(supportingTransactionIds) ? supportingTransactionIds : null,
    supportingTransactionIdsTotal: isFiniteNumber(supportingTransactionIdsTotal)
      ? supportingTransactionIdsTotal
      : null,
    threshold: pickFiniteNumbers(threshold, ['ratio']),
  }
}

function renderRecurringIncrease(metadata: unknown): ReactNode | null {
  const m = parseRecurringIncrease(metadata)
  if (!m) return null
  if (!m.priorMonths) {
    // OLD SHAPE fallback — same rendering this component always produced.
    const delta = m.currentAmount - m.priorAmount
    return (
      <EvidenceLine>
        {formatMoney(m.priorAmount, m.currency)}/mo → {formatMoney(m.currentAmount, m.currency)} this
        month (+{formatMoney(delta, m.currency)})
      </EvidenceLine>
    )
  }
  return (
    <>
      <MonthTrailLine
        priorMonths={m.priorMonths}
        currentMonth={m.currentMonth}
        currentAmount={m.currentAmount}
        currency={m.currency}
      />
      {m.supportingTransactionIds ? (
        <EvidenceDetails
          summary={cappedCountLabel(m.supportingTransactionIds, m.supportingTransactionIdsTotal, 'supporting transaction')}
        >
          <TransactionLinks ids={m.supportingTransactionIds} total={m.supportingTransactionIdsTotal} />
        </EvidenceDetails>
      ) : null}
      {m.threshold ? (
        <ThresholdNote>
          Flagged because this month is at least {Math.round((m.threshold.ratio - 1) * 100)}% above the prior
          average.
        </ThresholdNote>
      ) : null}
    </>
  )
}

// ---- missing_receipt --------------------------------------------------------

type MissingReceiptMeta = {
  transactionId: number
  amount: number
  currency: string
  merchant: string
  date: string
}

function parseMissingReceipt(m: unknown): MissingReceiptMeta | null {
  if (!isRecord(m)) return null
  const { transactionId, amount, currency, merchant, date } = m
  if (typeof transactionId !== 'number' || !Number.isInteger(transactionId)) return null
  if (!isFiniteNumber(amount)) return null
  if (!isNonEmptyString(currency)) return null
  if (!isNonEmptyString(merchant)) return null
  if (!isNonEmptyString(date)) return null
  return { transactionId, amount, currency, merchant, date }
}

function renderMissingReceipt(metadata: unknown): ReactNode | null {
  const m = parseMissingReceipt(metadata)
  if (!m) return null
  // ~140 of these exist in production, and the rule that fires is the same
  // fixed threshold on every one of them — a repeated threshold footnote on
  // every row would add visual weight without adding signal. Kept to one
  // line, no disclosure.
  return (
    <EvidenceLine>
      <Link
        to={txnHref(m.transactionId)}
        className="text-primary underline-offset-4 hover:underline"
      >
        {m.merchant} · {formatMoney(m.amount, m.currency)} · {m.date}
      </Link>
    </EvidenceLine>
  )
}

// ---- cash_runway_low ---------------------------------------------------------

type CashRunwayMeta = {
  currency: string
  crossingDate: string
  projectedBalance: number
  buffer: number
  horizonDays: number
  threshold: { horizonDays: number; buffer: number; criticalDays: number } | null
}

function parseCashRunwayLow(m: unknown): CashRunwayMeta | null {
  if (!isRecord(m)) return null
  const { currency, crossingDate, projectedBalance, buffer, horizonDays, threshold } = m
  if (!isNonEmptyString(currency)) return null
  if (!isNonEmptyString(crossingDate)) return null
  if (!isFiniteNumber(projectedBalance)) return null
  if (!isFiniteNumber(buffer)) return null
  if (!isFiniteNumber(horizonDays)) return null
  return {
    currency,
    crossingDate,
    projectedBalance,
    buffer,
    horizonDays,
    threshold: pickFiniteNumbers(threshold, ['horizonDays', 'buffer', 'criticalDays']),
  }
}

function renderCashRunwayLow(metadata: unknown): ReactNode | null {
  const m = parseCashRunwayLow(metadata)
  if (!m) return null
  return (
    <>
      <EvidenceLine>
        Projected balance {formatMoney(m.projectedBalance, m.currency)} on {m.crossingDate} — below
        buffer {formatMoney(m.buffer, m.currency)} within {m.horizonDays}d
      </EvidenceLine>
      {m.threshold ? (
        <ThresholdNote>
          Flagged because the projected balance drops below {formatMoney(m.threshold.buffer, m.currency)} within{' '}
          {m.threshold.horizonDays} days (critical inside {m.threshold.criticalDays} days).
        </ThresholdNote>
      ) : null}
    </>
  )
}

// ---- category_trend -----------------------------------------------------------

type CategoryTrendMeta = {
  category: string
  currency: string
  windowEndMonth: string
  monthlyTotals: number[]
  risePct: number | null
  threshold: { ratio: number; warningRatio: number; minAmount: number } | null
}

function parseCategoryTrend(m: unknown): CategoryTrendMeta | null {
  if (!isRecord(m)) return null
  const { category, currency, windowEndMonth, monthlyTotals, risePct, threshold } = m
  if (!isNonEmptyString(category)) return null
  if (!isNonEmptyString(currency)) return null
  if (!isNonEmptyString(windowEndMonth)) return null
  if (!isFiniteNumberArray(monthlyTotals)) return null
  return {
    category,
    currency,
    windowEndMonth,
    monthlyTotals,
    risePct: isFiniteNumber(risePct) ? risePct : null,
    threshold: pickFiniteNumbers(threshold, ['ratio', 'warningRatio', 'minAmount']),
  }
}

/** `monthlyTotals` is oldest → newest, ending at `windowEndMonth`. Rebuilds
 *  the per-entry "YYYY-MM" labels so the trail reads as month → amount. */
function monthLabelsEndingAt(endMonth: string, count: number): string[] {
  const match = /^(\d{4})-(\d{2})$/.exec(endMonth)
  if (!match) return []
  const year = Number(match[1])
  const month = Number(match[2])
  const out: string[] = []
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(year, month - 1 - i, 1))
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`)
  }
  return out
}

function renderCategoryTrend(metadata: unknown): ReactNode | null {
  const m = parseCategoryTrend(metadata)
  if (!m) return null
  const labels = monthLabelsEndingAt(m.windowEndMonth, m.monthlyTotals.length)
  const trail = m.monthlyTotals
    .map((v, i) => `${labels[i] ?? '…'}: ${formatMoney(v, m.currency)}`)
    .join(' → ')
  return (
    <>
      <div className="mt-1 flex items-center gap-2">
        <Sparkline data={m.monthlyTotals} width={48} height={16} tone="negative" />
        <span className="text-xs text-muted-foreground">{trail}</span>
      </div>
      {m.threshold ? (
        <ThresholdNote>
          Flagged because spend rose at least {Math.round(m.threshold.ratio * 100)}% over the window and the
          latest month is above {formatMoney(m.threshold.minAmount, m.currency)}.
        </ThresholdNote>
      ) : null}
    </>
  )
}

// ---- settlement_imbalance -----------------------------------------------------

type SettlementImbalanceMeta = {
  currency: string
  netAmount: number
  direction: string | null
  threshold: { minNet: number; criticalNet: number } | null
}

function parseSettlementImbalance(m: unknown): SettlementImbalanceMeta | null {
  if (!isRecord(m)) return null
  const { currency, netAmount, direction, threshold } = m
  if (!isNonEmptyString(currency)) return null
  if (!isFiniteNumber(netAmount)) return null
  return {
    currency,
    netAmount,
    direction: isNonEmptyString(direction) ? direction : null,
    threshold: pickFiniteNumbers(threshold, ['minNet', 'criticalNet']),
  }
}

function renderSettlementImbalance(metadata: unknown): ReactNode | null {
  const m = parseSettlementImbalance(metadata)
  if (!m) return null
  return (
    <>
      <EvidenceLine>
        Net {formatMoney(m.netAmount, m.currency)}
        {m.direction ? ` (${m.direction.replace(/_/g, ' ')})` : ''}
      </EvidenceLine>
      {m.threshold ? (
        <ThresholdNote>
          Flagged because the net imbalance is above {formatMoney(m.threshold.minNet, m.currency)} (critical
          above {formatMoney(m.threshold.criticalNet, m.currency)}).
        </ThresholdNote>
      ) : null}
    </>
  )
}

// ---- subscription_price_increase -----------------------------------------------

type SubscriptionPriceIncreaseMeta = {
  previousAmountCents: number
  newAmountCents: number
  currency: string
  pctChange: number | null
  triggeringTransactionId: number | null
}

function parseSubscriptionPriceIncrease(m: unknown): SubscriptionPriceIncreaseMeta | null {
  if (!isRecord(m)) return null
  const { previousAmountCents, newAmountCents, currency, pctChange, triggeringTransactionId } = m
  if (!isFiniteNumber(previousAmountCents)) return null
  if (!isFiniteNumber(newAmountCents)) return null
  if (!isNonEmptyString(currency)) return null
  return {
    previousAmountCents,
    newAmountCents,
    currency,
    pctChange: isFiniteNumber(pctChange) ? pctChange : null,
    triggeringTransactionId:
      typeof triggeringTransactionId === 'number' && Number.isInteger(triggeringTransactionId)
        ? triggeringTransactionId
        : null,
  }
}

function renderSubscriptionPriceIncrease(metadata: unknown): ReactNode | null {
  const m = parseSubscriptionPriceIncrease(metadata)
  if (!m) {
    // Dismissing this type via the money-leaks flow stamps the generic leak
    // snapshot shape instead of the detector's own shape (same `type`, GET
    // /api/insights doesn't filter by entityType) — fall back to that.
    return renderMoneyLeakSnapshot(metadata)
  }
  const before = m.previousAmountCents / 100
  const after = m.newAmountCents / 100
  return (
    <EvidenceLine>
      {m.triggeringTransactionId != null ? (
        <Link
          to={txnHref(m.triggeringTransactionId)}
          className="text-primary underline-offset-4 hover:underline"
        >
          {formatMoney(before, m.currency)} → {formatMoney(after, m.currency)}
        </Link>
      ) : (
        <>
          {formatMoney(before, m.currency)} → {formatMoney(after, m.currency)}
        </>
      )}
      {m.pctChange != null ? ` (+${m.pctChange.toFixed(0)}%)` : ''}
    </EvidenceLine>
  )
}

// ---- money-leak snapshot (small_subscription, recurring_fee, --------------------
// ---- duplicate_service, delivery_fee_high) ---------------------------------------
// These types only ever reach the Insight table as a dismissed-leak
// "snapshot" (frontend/src/pages/MoneyLeaksPage.tsx `dismiss()`), never a
// detector-produced open insight — see backend/src/routes/moneyLeaks.ts.

type MoneyLeakSnapshotMeta = {
  title: string
  currency: string
  monthlyImpact: number
  annualImpact: number
}

function parseMoneyLeakSnapshot(m: unknown): MoneyLeakSnapshotMeta | null {
  if (!isRecord(m)) return null
  const { title, currency, monthlyImpact, annualImpact } = m
  if (!isNonEmptyString(title)) return null
  if (!isNonEmptyString(currency)) return null
  if (!isFiniteNumber(monthlyImpact)) return null
  if (!isFiniteNumber(annualImpact)) return null
  return { title, currency, monthlyImpact, annualImpact }
}

function renderMoneyLeakSnapshot(metadata: unknown): ReactNode | null {
  const m = parseMoneyLeakSnapshot(metadata)
  if (!m) return null
  return (
    <EvidenceLine>
      {formatMoney(m.monthlyImpact, m.currency)}/mo · {formatMoney(m.annualImpact, m.currency)}/yr
    </EvidenceLine>
  )
}

// ---- lookup + entry point -------------------------------------------------------

const EVIDENCE_RENDERERS: Record<string, (metadata: unknown) => ReactNode | null> = {
  duplicate_transactions: renderDuplicateTransactions,
  merchant_spend_spike: renderMerchantSpendSpike,
  recurring_increase: renderRecurringIncrease,
  unusual_category_spend: renderUnusualCategorySpend,
  missing_receipt: renderMissingReceipt,
  cash_runway_low: renderCashRunwayLow,
  category_trend: renderCategoryTrend,
  settlement_imbalance: renderSettlementImbalance,
  subscription_price_increase: renderSubscriptionPriceIncrease,
  small_subscription: renderMoneyLeakSnapshot,
  recurring_fee: renderMoneyLeakSnapshot,
  duplicate_service: renderMoneyLeakSnapshot,
  delivery_fee_high: renderMoneyLeakSnapshot,
}

/**
 * The "why" strip under an insight's description. Renders nothing for an
 * unrecognized `type`, for malformed/missing `metadata`, or if a renderer
 * throws for any other reason — evidence is supporting detail, never a
 * reason to break the row.
 */
export function InsightEvidence({
  type,
  metadata,
}: {
  type: string
  metadata: unknown
}): ReactNode {
  const renderer = EVIDENCE_RENDERERS[type]
  if (!renderer) return null
  try {
    return renderer(metadata)
  } catch {
    return null
  }
}
