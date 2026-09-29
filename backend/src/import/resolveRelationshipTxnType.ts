/**
 * The transaction type that gates the transfer-sibling hunt in stage 7.
 *
 * `detectRelationshipsStage` uses it for two things — finding the sibling, and
 * stamping `autoCategory: 'Transfer'`, which it deliberately withholds for a card
 * payment. So the precedence here is load-bearing, and it is the same ladder
 * `commitStatementImport` already applies to the stored column, so the two agree:
 *
 *   1. an authoritative `overrideTxnType` from the source
 *   2. a HIGH-confidence narrative detection
 *   3. the source's weak `txnTypeHint`
 *   4. whatever the pipeline itself picked
 *
 * Tier 2 above tier 3 is the important one. Wealthsimple hints `WD` and `AFT_OUT`
 * as `transfer`, but "Pre-authorized Debit to AMEX BILL PYMT" is a payment and the
 * narrative says so; letting the hint win would relabel those, which prod has
 * already seen once — 38 card payments typed `transfer` against 24 typed `payment`.
 *
 * Lives in its own module rather than inside `enrich.ts`: `commitStatementImport`
 * imports `./enrich`, so hosting it there and importing it back would be a cycle.
 */
import type { Signal } from './enrichment/types';
import type { TxnType } from './enrichment/types';

/**
 * A narrative type only counts when the detector was sure. That confidence is what
 * lets a source's weak hint yield to real evidence without yielding to a coin flip.
 */
export function narrativeTxnType(signals: Signal[]): TxnType | null {
  const detected = signals.find((s) => s.source === 'type-detect' && s.fields.txnType);
  return detected && detected.confidence === 'high'
    ? (detected.fields.txnType as TxnType)
    : null;
}

export interface RelationshipTxnTypeInputs {
  /** The source's authoritative type, when it has one. */
  overrideTxnType?: TxnType | null;
  /** The source's weak suggestion, which a confident narrative may beat. */
  txnTypeHint?: TxnType | null;
  /** Signals emitted so far; stage 2 (detect-type) has already run. */
  signals: Signal[];
}

export function resolveRelationshipTxnType(
  { overrideTxnType, txnTypeHint, signals }: RelationshipTxnTypeInputs,
  /**
   * Tier 4: the pipeline's own pick. Injected so this stays exactly `pickTxnType`
   * rather than a lookalike — that function scans EVERY signal for a `txnType`,
   * not only `type-detect` ones, and falls back to `'purchase'` rather than null.
   * A near-miss here silently changes behaviour for the two callers that supply
   * neither input.
   */
  fallback: (signals: Signal[]) => TxnType,
): TxnType {
  return (
    overrideTxnType
    ?? narrativeTxnType(signals)
    ?? txnTypeHint
    ?? fallback(signals)
  );
}
