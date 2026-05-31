import type { Account } from '../models';
import { balanceAtDate } from '../networth/balanceAtDate';

/**
 * Current owed balance for a credit card, derived from its transaction stream.
 * Card balances are negative (charges outweigh payments); we surface the
 * magnitude as a positive "owed" figure. A positive raw balance (credit on the
 * card) yields 0 owed. Closed cards return 0 because balanceAtDate elides
 * everything after the close date.
 *
 * Shared between /api/credit-cards (#243) and /api/accounts utilization
 * enrichment (#437).
 */
export async function currentOwed(
  account: InstanceType<typeof Account>,
  asOf: string,
): Promise<number> {
  const balances = await balanceAtDate(account, asOf);
  const ccy = account.defaultCurrency ?? 'CAD';
  const match = balances.find((b) => b.currency === ccy) ?? balances[0];
  const raw = match ? match.amount : 0;
  return raw < 0 ? Math.abs(raw) : 0;
}

/**
 * Utilization percentage = current owed / credit limit × 100.
 * Returns null when limit is unset, ≤ 0, or non-finite. Caller decides
 * whether to suppress utilization for closed cards (this helper does not
 * inspect account state).
 */
export function utilizationPct(
  currentBalance: number,
  creditLimit: number | null,
): number | null {
  if (creditLimit == null) return null;
  if (!Number.isFinite(creditLimit) || creditLimit <= 0) return null;
  if (!Number.isFinite(currentBalance)) return null;
  return (currentBalance / creditLimit) * 100;
}
