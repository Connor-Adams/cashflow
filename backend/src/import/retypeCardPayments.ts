/**
 * Re-typing historical card payments.
 *
 * `detectTypeStage` recognizes a pre-authorized debit that names a card network
 * as a payment. Rows imported before that rule existed still carry whatever the
 * old ordering produced — in prod, 38 rows on the single narrative
 * "Pre-authorized Debit to AMEX BILL PYMT" typed `transfer`, against the same
 * narrative typed `payment` on rows written after the fix. One event, two
 * answers, split by import date.
 *
 * The decision is delegated to the detector rather than re-implemented here, so
 * this cannot drift from what the import path does. Two deliberate limits:
 *
 *   - It only ever promotes TO `payment`. Nothing is demoted, and no other
 *     type is rewritten, so a wrong answer here can only ever affect rows the
 *     detector is confident are card payments.
 *   - It requires `high` confidence, which the stage emits only when one of its
 *     narrative patterns actually matched — never for its sign-based fallbacks.
 */
import { runDetectTypeStage } from './enrichment/detectTypeStage';
import type { TxnType } from './enrichment/types';

export type RetypeCandidate = {
  merchantRaw: string;
  merchantClean: string;
  amount: number;
  txnType: TxnType | string | null;
};

/**
 * The type the detector assigns this row's narrative, or null unless it is
 * `high` confidence (a narrative pattern matched, not a sign-based fallback).
 * Shared with the other historical re-types so they all defer to the detector.
 */
export function confidentNarrativeType(row: RetypeCandidate): TxnType | null {
  const signal = runDetectTypeStage({
    merchantRaw: row.merchantRaw,
    merchantClean: row.merchantClean,
    amount: row.amount,
  }).find((s) => s.fields.txnType);
  return signal?.confidence === 'high' ? (signal.fields.txnType ?? null) : null;
}

export function shouldRetypeAsPayment(row: RetypeCandidate): boolean {
  if (row.txnType === 'payment') return false;
  return confidentNarrativeType(row) === 'payment';
}
