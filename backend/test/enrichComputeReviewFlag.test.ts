import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeSignals } from '../src/import/enrichment/computeReviewFlag';
import type { Signal } from '../src/import/enrichment/types';

function s(source: Signal['source'], confidence: Signal['confidence'], fields: Signal['fields']): Signal {
  return { source, confidence, fields };
}

test('rule wins over memory and ai for category', () => {
  const merged = mergeSignals([
    s('memory', 'high', { autoCategory: 'Memory' }),
    s('rule', 'high', { autoCategory: 'Rule' }),
    s('ai', 'high', { autoCategory: 'AI' }),
  ]);
  assert.equal(merged.fields.autoCategory, 'Rule');
  assert.equal(merged.fields.autoSource, 'rule');
});

test('rule + memory + item-link: rule wins, autoSource=composite', () => {
  const merged = mergeSignals([
    s('memory', 'high', { autoCategory: 'M' }),
    s('rule', 'high', { autoCategory: 'R', appliedRuleId: 5 }),
    s('item-link', 'high', { autoCategory: 'A', linkedExternalOrderId: 7 }),
  ]);
  assert.equal(merged.fields.appliedRuleId, 5);
  // item-link still contributes a non-conflicting field
  assert.equal(merged.fields.linkedExternalOrderId, 7);
  assert.equal(merged.fields.autoSource, 'composite');
});

test('ai-high alone keeps review_flag=true (AI alone never skips review)', () => {
  const merged = mergeSignals([s('ai', 'high', { autoCategory: 'AI' })]);
  assert.equal(merged.fields.autoCategory, 'AI');
  assert.equal(merged.fields.reviewFlag, true);
});

test('rule-high alone clears review_flag', () => {
  const merged = mergeSignals([s('rule', 'high', { autoCategory: 'R' })]);
  assert.equal(merged.fields.reviewFlag, false);
});

test('memory(1) alone keeps review_flag=true (medium confidence)', () => {
  const merged = mergeSignals([s('memory', 'medium', { autoCategory: 'M' })]);
  assert.equal(merged.fields.reviewFlag, true);
});

test('no signals -> review_flag=true, all auto fields null', () => {
  const merged = mergeSignals([]);
  assert.equal(merged.fields.reviewFlag, true);
  assert.equal(merged.fields.autoCategory, null);
  assert.equal(merged.fields.autoSource, null);
});

test('normalize stage always provides merchantClean even without other signals', () => {
  const merged = mergeSignals([
    s('normalize-seed', 'high', { merchantClean: 'NETFLIX', merchantCanonical: 'Netflix' }),
  ]);
  assert.equal(merged.fields.merchantClean, 'NETFLIX');
  assert.equal(merged.fields.merchantCanonical, 'Netflix');
  // Normalize alone does not provide category → still needs review
  assert.equal(merged.fields.reviewFlag, true);
});

test('refund-link inherits category and clears review_flag', () => {
  const merged = mergeSignals([
    s('refund-link', 'high', { autoCategory: 'Shopping', linkedTransactionId: 7 }),
  ]);
  assert.equal(merged.fields.reviewFlag, false);
  assert.equal(merged.fields.linkedTransactionId, 7);
});

test('recurring with NULL autoCategory does not claim autoSource (regression for 2026-05-23 prod bug)', () => {
  // detectRecurringStage emits {isRecurring: true, autoCategory: null} when
  // monthly cadence matches but priors had no finalCategory. Before the fix,
  // null still claimed autoSource='recurring' but categoryWinner skipped it
  // → 12 prod rows with auto_source='recurring' and auto_confidence=NULL.
  const merged = mergeSignals([
    s('normalize-seed', 'high', { merchantClean: 'APPLE.COM/BILL TORONTO' }),
    s('type-detect', 'high', { txnType: 'purchase' }),
    s('recurring', 'high', { isRecurring: true, autoCategory: null }),
  ]);
  assert.equal(merged.fields.isRecurring, true);
  assert.equal(merged.fields.autoCategory, null);
  assert.equal(merged.fields.autoSource, null);
  assert.equal(merged.fields.autoConfidence, null);
  assert.equal(merged.fields.reviewFlag, true);
});

test('recurring with category claims source and confidence', () => {
  const merged = mergeSignals([
    s('recurring', 'high', { isRecurring: true, autoCategory: 'Subscriptions' }),
  ]);
  assert.equal(merged.fields.isRecurring, true);
  assert.equal(merged.fields.autoCategory, 'Subscriptions');
  assert.equal(merged.fields.autoSource, 'recurring');
  assert.equal(merged.fields.autoConfidence, 'high');
  assert.equal(merged.fields.reviewFlag, false);
});

test('null classification field on lower-precedence signal does not erase higher-precedence value', () => {
  // Defensive: if some stage ever emits an explicit null on a classification
  // field below another stage's real value, the real value must persist.
  const merged = mergeSignals([
    s('rule', 'high', { autoCategory: 'Groceries' }),
    s('memory', 'high', { autoCategory: null }),
  ]);
  assert.equal(merged.fields.autoCategory, 'Groceries');
  assert.equal(merged.fields.autoSource, 'rule');
});
