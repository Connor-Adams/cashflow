import type { Account } from '../models';
import { balanceAtDate } from '../networth/balanceAtDate';
import { looseHistoricalFxLookup } from '../networth/aggregate';
import type { FxLookup } from '../networth/unifyToCad';
import { toUnits, fromUnits } from '../util/numbers';

/**
 * Current owed balance for a credit card, in the card's default currency,
 * derived from its transaction stream. Card balances are negative (charges
 * outweigh payments); we surface the magnitude as a positive "owed" figure. A
 * positive net balance (credit on the card) yields 0 owed. Closed cards return
 * 0 because balanceAtDate elides everything after the close date.
 *
 * Multi-currency: a card can carry charges in more than one currency (e.g. a
 * USD purchase on a CAD card). Every non-default-currency bucket is
 * FX-converted into the card's default currency at `asOf` and summed — the
 * same FX-normalization net worth uses — so foreign legs are folded in rather
 * than silently dropped (the prior `balances.find(defCcy) ?? balances[0]` only
 * ever looked at one bucket). Converting into the card's *own* currency keeps
 * the owed figure comparable to the card's native credit limit (the
 * per-currency utilization dashboard divides one by the other). A bucket with
 * no resolvable rate falls back to its native amount rather than being dropped.
 * FX is injectable for tests.
 *
 * Shared between /api/credit-cards (#243) and /api/accounts utilization
 * enrichment (#437).
 */
export async function currentOwed(
  account: InstanceType<typeof Account>,
  asOf: string,
  fxLookup: FxLookup = looseHistoricalFxLookup,
): Promise<number> {
  const balances = await balanceAtDate(account, asOf);
  const defCcy = (account.defaultCurrency ?? 'CAD').toUpperCase();
  let netU = 0;
  for (const { currency, amount } of balances) {
    if (currency.toUpperCase() === defCcy) {
      netU += toUnits(amount);
      continue;
    }
    const fx = await fxLookup(currency, defCcy, asOf);
    netU += toUnits(fx ? amount * fx.rate : amount);
  }
  const net = fromUnits(netU);
  return net < 0 ? Math.abs(net) : 0;
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
