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
  const abs = Math.abs(v).toFixed(2)
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
  const abs = Math.abs(v).toFixed(2)
  const label = v >= 0 ? 'net out' : 'net in'
  return `${n.currency} ${abs} ${label}`
}
