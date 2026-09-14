import type { LoanBalance, TransferNet } from '@cashflow/shared'

/**
 * Human label for a signed loan balance. Positive: they owe you.
 *
 * Takes only the two fields it reads so a caller holding an aggregated
 * per-currency total can label it without inventing lent/repaid components.
 */
export function formatBalanceLabel(b: Pick<LoanBalance, 'currency' | 'balance'>): string {
  const v = Number(b.balance)
  const abs = Math.abs(v).toFixed(2)
  const label = v > 0 ? 'owed to you' : v < 0 ? 'you owe' : 'settled'
  return `${b.currency} ${abs} ${label}`
}

/**
 * Human label for raw flow. Deliberately says nothing about debt — this is a
 * description of movement, and calling it "owed" is the bug this page had.
 */
export function formatNetFlowLabel(n: TransferNet): string {
  const v = Number(n.net)
  const abs = Math.abs(v).toFixed(2)
  const label = v >= 0 ? 'net out' : 'net in'
  return `${n.currency} ${abs} ${label}`
}
