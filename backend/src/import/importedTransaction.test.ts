import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveImportedTxnType, transferSiblingId } from './importedTransaction';
import type { EnrichmentResult, Signal, TxnType } from './enrichment/types';

function enriched(signals: Signal[], over: Partial<EnrichmentResult['fields']> = {}): EnrichmentResult {
  return {
    signals,
    fields: {
      merchantClean: 'X',
      merchantCanonical: null,
      txnType: 'purchase',
      autoCategory: null,
      autoBusiness: null,
      autoSplitType: null,
      autoPctMe: null,
      autoPctPartner: null,
      appliedRuleId: null,
      linkedTransactionId: null,
      linkedExternalOrderId: null,
      isRecurring: false,
      notes: null,
      autoSource: null,
      autoConfidence: null,
      reviewFlag: true,
      ...over,
    },
  };
}

const narrative = (txnType: TxnType, confidence: Signal['confidence'] = 'high'): Signal => ({
  source: 'type-detect',
  confidence,
  fields: { txnType },
});
const rule = (txnType: TxnType): Signal => ({ source: 'rule', confidence: 'high', fields: { txnType } });

test('resolveImportedTxnType: authoritative override beats everything', () => {
  const e = enriched([narrative('payment'), rule('fee')], { txnType: 'fee' });
  assert.equal(resolveImportedTxnType({ overrideTxnType: 'investment', txnTypeHint: 'transfer' }, e), 'investment');
});

test('resolveImportedTxnType: a user rule beats a confident narrative', () => {
  const e = enriched([narrative('payment'), rule('transfer')], { txnType: 'transfer' });
  assert.equal(resolveImportedTxnType({}, e), 'transfer');
});

test('resolveImportedTxnType: a confident narrative beats the source hint', () => {
  // The WS `AFT_OUT` → transfer hint on "Pre-authorized Debit to AMEX BILL PYMT".
  const e = enriched([narrative('payment')], { txnType: 'payment' });
  assert.equal(resolveImportedTxnType({ txnTypeHint: 'transfer' }, e), 'payment');
});

test('resolveImportedTxnType: the hint beats a guessed narrative', () => {
  const e = enriched([narrative('purchase', 'medium')], { txnType: 'purchase' });
  assert.equal(resolveImportedTxnType({ txnTypeHint: 'transfer' }, e), 'transfer');
});

test('resolveImportedTxnType: no source opinion falls back to the merged type', () => {
  const e = enriched([narrative('purchase', 'medium')], { txnType: 'purchase' });
  assert.equal(resolveImportedTxnType({}, e), 'purchase');
});

test('transferSiblingId: returns the id a transfer-link supplied', () => {
  const e = enriched(
    [{ source: 'transfer-link', confidence: 'high', fields: { linkedTransactionId: 7 } }],
    { linkedTransactionId: 7 },
  );
  assert.equal(transferSiblingId(e), 7);
});

test('transferSiblingId: a refund link is not a transfer sibling', () => {
  for (const source of ['refund-link', 'refund-link-suggested'] as const) {
    const e = enriched(
      [{ source, confidence: 'high', fields: { linkedTransactionId: 7 } }],
      { linkedTransactionId: 7 },
    );
    assert.equal(transferSiblingId(e), null, source);
  }
});

test('transferSiblingId: null when nothing linked', () => {
  assert.equal(transferSiblingId(enriched([])), null);
});
