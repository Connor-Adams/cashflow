import type { TransferNet } from '@cashflow/shared'

/** Human label for a per-currency net: positive = the person owes you. */
export function formatNetLabel(n: TransferNet): string {
  const v = Number(n.net)
  const abs = Math.abs(v).toFixed(2)
  return `${n.currency} ${abs} ${v >= 0 ? 'owed to you' : 'you owe'}`
}
