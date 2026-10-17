/**
 * Precedence for the type that gates the transfer-sibling hunt.
 *
 * `detectRelationshipsStage` uses this value for two things: finding the sibling,
 * and stamping `autoCategory: 'Transfer'` — which it deliberately withholds for a
 * card payment. So a naive "caller wins" would relabel every Wealthsimple row
 * carrying `txnTypeHint: 'transfer'`, including "Pre-authorized Debit to AMEX BILL
 * PYMT", which the narrative detector types `payment` at high confidence. That is
 * the inversion prod already recorded once: 38 card payments typed `transfer`
 * against 24 typed `payment`.
 *
 * The ladder is the one the commit path already uses, so the two agree.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRelationshipTxnType } from './resolveRelationshipTxnType';
import type { Signal, TxnType } from './enrichment/types';

/** Mirrors `enrich.ts`'s own pickTxnType, which is what production injects. */
function pickTxnType(signals: Signal[]): TxnType {
  for (const s of signals) {
    if (s.fields.txnType) return s.fields.txnType as TxnType;
  }
  return 'purchase';
}

function typeDetect(txnType: string, confidence: 'high' | 'medium' | 'low'): Signal {
  return {
    source: 'type-detect',
    confidence,
    fields: { txnType },
    rationale: 'test',
  } as unknown as Signal;
}

test('an authoritative override beats a high-confidence narrative', () => {
  // The forward-fix mirror: its activityType is unambiguous, its wording is not.
  const got = resolveRelationshipTxnType({
    overrideTxnType: 'transfer',
    txnTypeHint: null,
    signals: [typeDetect('purchase', 'high')],
  }, pickTxnType);
  assert.equal(got, 'transfer');
});

test('a high-confidence narrative beats a weak hint', () => {
  // "Pre-authorized Debit to AMEX BILL PYMT" — payment, not transfer. This is the
  // regression guard for autoCategory: 'Transfer' on card payments.
  const got = resolveRelationshipTxnType({
    overrideTxnType: null,
    txnTypeHint: 'transfer',
    signals: [typeDetect('payment', 'high')],
  }, pickTxnType);
  assert.equal(got, 'payment');
});

test('a hint wins when the narrative is silent', () => {
  // "Money transfer into the account" matches no narrative pattern, so the
  // retroactive converter's hint is what makes the transfer_in case link.
  const got = resolveRelationshipTxnType({
    overrideTxnType: null,
    txnTypeHint: 'transfer',
    signals: [],
  }, pickTxnType);
  assert.equal(got, 'transfer');
});

test('a hint wins over a merely medium-confidence narrative', () => {
  const got = resolveRelationshipTxnType({
    overrideTxnType: null,
    txnTypeHint: 'transfer',
    signals: [typeDetect('purchase', 'medium')],
  }, pickTxnType);
  assert.equal(got, 'transfer');
});

test('with neither input it is exactly pickTxnType — any signal, not just type-detect', () => {
  // pickTxnType scans EVERY signal for fields.txnType, not only type-detect ones.
  // runImport and runEnrichmentBackfill supply neither input, so tier 4 must match
  // that exactly or their behaviour changes.
  const fromAnotherStage = {
    source: 'detect-recurring', confidence: 'low', fields: { txnType: 'income' }, rationale: 't',
  } as unknown as Signal;
  const got = resolveRelationshipTxnType({
    overrideTxnType: null,
    txnTypeHint: null,
    signals: [fromAnotherStage],
  }, pickTxnType);
  assert.equal(got, 'income');
});

test('with neither input and no signals it defaults to purchase, as pickTxnType does', () => {
  const got = resolveRelationshipTxnType({
    overrideTxnType: null,
    txnTypeHint: null,
    signals: [],
  }, pickTxnType);
  assert.equal(got, 'purchase');
});
