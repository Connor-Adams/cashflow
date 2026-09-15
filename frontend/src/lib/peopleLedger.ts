import type { LoanBalance, TransferNet } from '@cashflow/shared'

/**
 * A money string off the wire as a number, or `null` when it does not carry
 * one. `Number('')` and `Number(null)` are both `0`, so a bare `Number()` turns
 * "no value" into "zero" — and a zero balance is the claim "settled". Absent,
 * blank and non-numeric all have to fail the same way: unknown, not zero.
 */
function parseAmount(raw: string | null | undefined): number | null {
  if (raw == null) return null
  if (typeof raw === 'string' && raw.trim() === '') return null
  const v = Number(raw)
  return Number.isFinite(v) ? v : null
}

/**
 * Grouped, 2-decimal money formatting shared by every dollar figure on the
 * People page: `6,700.00`, not `6700.00`. One instance so a loan balance and
 * an interest figure rendered side by side (the contact drill-in shows both)
 * never drift into two different thousands conventions again.
 */
export const AMOUNT_FORMAT = new Intl.NumberFormat('en-CA', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

/**
 * Human label for a signed loan balance. Positive: they owe you.
 *
 * Takes only the two fields it reads so a caller holding an aggregated
 * per-currency total can label it without inventing lent/repaid components.
 *
 * A balance that is not a finite number reads "balance unknown" and makes no
 * claim in either direction. `deriveMetrics` and `peakBalance` guard their own
 * arithmetic, but the per-row and drill-in callers hand their DTO straight
 * here, so the guard has to live inside this function too.
 */
export function formatBalanceLabel(b: Pick<LoanBalance, 'currency' | 'balance'>): string {
  const v = parseAmount(b.balance)
  if (v === null) return `${b.currency} balance unknown`
  const abs = AMOUNT_FORMAT.format(Math.abs(v))
  const label = v > 0 ? 'owed to you' : v < 0 ? 'you owe' : 'settled'
  return `${b.currency} ${abs} ${label}`
}

/**
 * Human label for raw flow. Deliberately says nothing about debt — this is a
 * description of movement, and calling it "owed" is the bug this page had.
 */
export function formatNetFlowLabel(n: TransferNet): string {
  const v = parseAmount(n.net)
  if (v === null) return `${n.currency} flow unknown`
  const abs = AMOUNT_FORMAT.format(Math.abs(v))
  const label = v >= 0 ? 'net out' : 'net in'
  return `${n.currency} ${abs} ${label}`
}

// ── Line-of-credit interest ──────────────────────────────────────────────────

/**
 * Interest is THREE figures and a total, never one number. See "Two figures,
 * never merged" in `docs/superpowers/specs/2026-09-15-loc-interest-attribution-design.md`.
 *
 *   - `principal` — the signed loan balance. Tagged loans, less repayments.
 *   - `charged`   — apportioned from the Applicable Interest RBC printed on a
 *                   statement. Traces to a document.
 *   - `accrued`   — days since that statement, at the rate now in force. The
 *                   only figure on the People page with no document behind it,
 *                   so anything showing it (or a total containing it) has to
 *                   say so.
 *
 * `null` means "there is none / it is not known", and every caller renders that
 * as nothing rather than as a confident zero.
 */
export interface OwedBreakdown {
  currency: string
  principal: number | null
  charged: number | null
  accrued: number | null
  /** principal + charged + accrued, or `null` when the principal is unknown. */
  total: number | null
  /** True when `total` contains `accrued`, i.e. the total is part estimate. */
  totalIncludesEstimate: boolean
}

/** Amounts below a hundredth of a cent are nothing, not a figure worth a row. */
const INTEREST_EPSILON = 0.00005

/** A fixed-4 figure as a number, or `null` when it is absent, blank or not one. */
function amountOrNull(raw: string | null | undefined): number | null {
  const v = parseAmount(raw)
  if (v === null) return null
  return Math.abs(v) < INTEREST_EPSILON ? null : v
}

function balanceIn(rows: LoanBalance[] | undefined, currency: string): number | null {
  const hit = rows?.find((r) => r.currency === currency)
  return hit ? parseAmount(hit.balance) : null
}

/**
 * The per-currency interest breakdown for one contact, or an empty array when
 * the contact has no line-of-credit interest at all.
 *
 * Empty is the point: a contact who was never funded off the line must show no
 * interest element whatsoever, not `CAD 0.00`. A zero interest figure would
 * read as "we computed this and it came to nothing", which is a different (and
 * false) claim from "this person has none".
 *
 * Only currencies carrying interest get a row — the principal alone is already
 * reported by the loan-balance tile and does not need repeating here.
 */
export function buildOwedBreakdown(ledger: {
  loanBalance?: LoanBalance[]
  interestCharged?: LoanBalance[]
  interestAccrued?: LoanBalance[]
} | null): OwedBreakdown[] {
  if (!ledger) return []
  const currencies = new Set<string>()
  for (const r of ledger.interestCharged ?? []) currencies.add(r.currency)
  for (const r of ledger.interestAccrued ?? []) currencies.add(r.currency)

  const out: OwedBreakdown[] = []
  for (const currency of [...currencies].sort()) {
    const charged = amountOrNull(
      ledger.interestCharged?.find((r) => r.currency === currency)?.balance,
    )
    const accrued = amountOrNull(
      ledger.interestAccrued?.find((r) => r.currency === currency)?.balance,
    )
    if (charged === null && accrued === null) continue
    const principal = balanceIn(ledger.loanBalance, currency)
    out.push({
      currency,
      principal,
      charged,
      accrued,
      // No principal figure, no total. Treating a missing balance as 0 would
      // publish an "owed" number built on a blank.
      total: principal === null ? null : principal + (charged ?? 0) + (accrued ?? 0),
      totalIncludesEstimate: principal !== null && accrued !== null,
    })
  }
  return out
}

/**
 * The rate history behind the charged figure, as one line:
 * `9.440% to 2025-09-17 · 9.190% to 2025-10-29 · 8.940% since`.
 *
 * Consecutive windows at the same rate collapse into one span, so the line
 * shows rate CHANGES rather than one entry per statement period — a reader
 * should see the line step without leaving the page. Returns `''` when no
 * statement has been imported, and callers render nothing for that.
 */
export function formatRateWindows(
  windows: Array<{ fromDate: string; toDate: string; effectiveRate: string }> | undefined,
): string {
  const sorted = [...(windows ?? [])].sort((a, b) => a.fromDate.localeCompare(b.fromDate))
  if (sorted.length === 0) return ''
  const spans: Array<{ rate: string; toDate: string }> = []
  for (const w of sorted) {
    const rate = parseAmount(w.effectiveRate)
    if (rate === null) continue
    const label = `${rate.toFixed(3)}%`
    const last = spans[spans.length - 1]
    if (last && last.rate === label) last.toDate = w.toDate
    else spans.push({ rate: label, toDate: w.toDate })
  }
  if (spans.length === 0) return ''
  return spans
    .map((s, i) => (i === spans.length - 1 ? `${s.rate} since` : `${s.rate} to ${s.toDate}`))
    .join(' · ')
}

/** The rate in force now: the latest window's. `null` when there is none. */
export function currentRateLabel(
  windows: Array<{ fromDate: string; effectiveRate: string }> | undefined,
): string | null {
  const sorted = [...(windows ?? [])].sort((a, b) => a.fromDate.localeCompare(b.fromDate))
  const last = sorted[sorted.length - 1]
  const rate = last ? parseAmount(last.effectiveRate) : null
  return rate === null ? null : `${rate.toFixed(3)}%`
}

/** The last day any statement covered — what "charged" is charged through. */
export function lastStatementDate(
  windows: Array<{ toDate: string }> | undefined,
): string | null {
  let latest: string | null = null
  for (const w of windows ?? []) {
    if (typeof w.toDate !== 'string' || w.toDate === '') continue
    if (latest === null || w.toDate > latest) latest = w.toDate
  }
  return latest
}

/**
 * How hard the statement bound the allocation.
 *
 * Each window's balance-based accrual is scaled down to the interest RBC
 * actually printed for it. On the real data that bound binds in 7 of 8 active
 * windows, because total lending exceeds the line — expected, not a fault. It
 * is surfaced rather than hidden because a sudden change in it means the
 * lending or the line moved.
 *
 * Windows that allocated nothing (no loan existed yet) are excluded: they are
 * not unbound, they are inapplicable, and counting them would dilute the ratio.
 * Returns `null` when no window allocated anything, so nothing is rendered.
 */
export interface ScalingSummary {
  /** Windows that allocated something — the denominator. */
  active: number
  /** Of those, how many were scaled down to the printed figure. */
  bound: number
  /** The smallest scaling factor across active windows, e.g. 0.42. */
  minFactor: number
  /**
   * Every window's printed Applicable Interest, summed — what RBC actually
   * billed. Counts the inapplicable windows too: they were billed, whether or
   * not anybody could be charged for them.
   */
  billed: number
  /**
   * What was actually attributed to people, summed the same way. Never above
   * `billed`; the difference is attributed to nobody.
   */
  attributed: number
}

export function summarizeScaling(
  windows:
    | Array<{ applicableInterest?: string; allocated: string; scalingFactor: string; bound: boolean }>
    | undefined,
): ScalingSummary | null {
  let active = 0
  let bound = 0
  let minFactor = Number.POSITIVE_INFINITY
  let billed = 0
  let attributed = 0
  for (const w of windows ?? []) {
    // The billed/attributed totals span EVERY window, not just the active ones.
    // Excluding a window that allocated nothing would hide exactly the residue
    // these two numbers exist to expose.
    billed += parseAmount(w.applicableInterest) ?? 0
    const allocated = parseAmount(w.allocated)
    if (allocated === null || Math.abs(allocated) < INTEREST_EPSILON) continue
    attributed += allocated
    active += 1
    if (w.bound) bound += 1
    const factor = parseAmount(w.scalingFactor)
    if (factor !== null && factor < minFactor) minFactor = factor
  }
  if (active === 0 || !Number.isFinite(minFactor)) return null
  return { active, bound, minFactor, billed, attributed }
}
