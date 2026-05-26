/**
 * Effective FX rate derivation.
 *
 * Given a transaction in some currency, attempt to derive the effective
 * exchange rate the bank actually applied by pairing it with a counterparty
 * transaction in a different currency on the same date.
 *
 * Two derivation paths, ordered by confidence:
 *   1. Explicit link: `txn.linkedTransactionId` points to a counterparty in
 *      a different currency on the same date. High confidence.
 *   2. Heuristic same-day opposite-sign pair: same account, same date,
 *      opposite signs, different currency. Lower confidence — useful for
 *      historical data where the import didn't record an explicit link.
 *
 * Pure function — no DB. The caller supplies the transaction and its
 * candidate counterparties.
 */

import { num } from '../util/numbers';

export interface RateDerivationTxn {
  id: number;
  accountId: number;
  date: string;
  amount: string | number;
  currency: string;
  linkedTransactionId: number | null;
}

export interface EffectiveFxRateResult {
  /** Exchange rate from `fromCurrency` to `toCurrency`. Always positive. */
  rate: number;
  fromCurrency: string;
  toCurrency: string;
  /** How we derived: explicit link beats heuristic. */
  source: 'linked_transaction' | 'paired_transfer';
  /** The other side of the trade. */
  counterpartyTxnId: number;
}

function magnitude(amount: string | number): number {
  return Math.abs(num(amount) ?? 0);
}

/**
 * Compute the rate that explains `target.amount` (in `target.currency`)
 * being paired with `counterparty.amount` (in `counterparty.currency`).
 *
 * The convention: rate is reported in the direction target→counterparty so
 * the caller can express it consistently with the txn perspective.
 */
function rateFromPair(
  target: RateDerivationTxn,
  counterparty: RateDerivationTxn
): EffectiveFxRateResult | null {
  const targetMag = magnitude(target.amount);
  const counterMag = magnitude(counterparty.amount);
  if (targetMag <= 0 || counterMag <= 0) return null;
  return {
    rate: counterMag / targetMag,
    fromCurrency: target.currency.toUpperCase(),
    toCurrency: counterparty.currency.toUpperCase(),
    source: 'paired_transfer', // overwritten by caller when applicable
    counterpartyTxnId: counterparty.id,
  };
}

function signsAreOpposite(a: string | number, b: string | number): boolean {
  const an = num(a) ?? 0;
  const bn = num(b) ?? 0;
  return (an < 0 && bn > 0) || (an > 0 && bn < 0);
}

export function deriveEffectiveRate(
  target: RateDerivationTxn,
  candidates: RateDerivationTxn[]
): EffectiveFxRateResult | null {
  const targetCurrency = target.currency.toUpperCase();

  // Path 1: explicit link wins if present and points at a different-currency
  // counterparty on the same date.
  if (target.linkedTransactionId != null) {
    const linked = candidates.find((c) => c.id === target.linkedTransactionId);
    if (
      linked &&
      linked.currency.toUpperCase() !== targetCurrency &&
      linked.date === target.date
    ) {
      const r = rateFromPair(target, linked);
      if (r) return { ...r, source: 'linked_transaction' };
    }
  }

  // Path 2: heuristic — same account, same date, opposite-sign, different currency.
  const heuristicMatches = candidates.filter(
    (c) =>
      c.id !== target.id &&
      c.accountId === target.accountId &&
      c.date === target.date &&
      c.currency.toUpperCase() !== targetCurrency &&
      signsAreOpposite(target.amount, c.amount)
  );

  if (heuristicMatches.length === 0) return null;

  // Pick the candidate with the largest absolute amount — that's the
  // settlement leg; smaller lines tend to be fees.
  heuristicMatches.sort((a, b) => magnitude(b.amount) - magnitude(a.amount));
  const best = heuristicMatches[0];
  const r = rateFromPair(target, best);
  if (r) return { ...r, source: 'paired_transfer' };
  return null;
}
