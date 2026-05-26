/**
 * Unit tests for the deterministic import-confidence classifier (#214).
 *
 * Pure function — no DB, no IO. We exercise the table of expected (input
 * shape → flag list + state) cases so a future refactor can't quietly change
 * the meaning of 'clean'.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeImportConfidence,
  serializeFlags,
  deserializeFlags,
  type ImportConfidenceInput,
  IMPORT_CONFIDENCE_FLAGS,
} from '../src/import/computeImportConfidence';

function baseInput(overrides: Partial<ImportConfidenceInput> = {}): ImportConfidenceInput {
  return {
    reviewFlag: false,
    finalCategory: 'Dining',
    autoCategory: 'Dining',
    autoSplitType: 'me',
    finalSplitType: 'me',
    txnType: 'purchase',
    accountVisibility: 'private',
    linkedTransactionId: null,
    amount: -25,
    ...overrides,
  };
}

test('clean state when fully enriched private spend row', () => {
  const result = computeImportConfidence(baseInput());
  assert.equal(result.state, 'clean');
  assert.deepEqual(result.flags, []);
});

test('reviewFlag=true → needs_review state and needs_review flag', () => {
  const result = computeImportConfidence(baseInput({ reviewFlag: true }));
  assert.equal(result.state, 'needs_review');
  assert.deepEqual(result.flags, ['needs_review']);
});

test('null categories → missing_category fires and state is needs_review', () => {
  const result = computeImportConfidence(
    baseInput({ finalCategory: null, autoCategory: null }),
  );
  assert.equal(result.state, 'needs_review');
  assert.ok(result.flags.includes('missing_category'));
});

test('empty-string categories count as missing', () => {
  const result = computeImportConfidence(
    baseInput({ finalCategory: '', autoCategory: '' }),
  );
  assert.ok(result.flags.includes('missing_category'));
});

test('autoCategory present but finalCategory null counts as having a category', () => {
  const result = computeImportConfidence(
    baseInput({ finalCategory: null, autoCategory: 'Dining' }),
  );
  assert.ok(!result.flags.includes('missing_category'));
  assert.equal(result.state, 'clean');
});

test('shared account with no autoSplitType on a spend row → missing_split', () => {
  const result = computeImportConfidence(
    baseInput({ accountVisibility: 'shared', autoSplitType: null }),
  );
  assert.ok(result.flags.includes('missing_split'));
  assert.equal(result.state, 'needs_review');
});

test('private account with no autoSplitType → no missing_split (irrelevant)', () => {
  const result = computeImportConfidence(
    baseInput({ accountVisibility: 'private', autoSplitType: null }),
  );
  assert.ok(!result.flags.includes('missing_split'));
});

test('shared account refund row does not require split classification', () => {
  const result = computeImportConfidence(
    baseInput({
      accountVisibility: 'shared',
      autoSplitType: null,
      txnType: 'refund',
      amount: 25,
    }),
  );
  assert.ok(!result.flags.includes('missing_split'));
});

test('positive-amount row on shared account does not require split', () => {
  const result = computeImportConfidence(
    baseInput({
      accountVisibility: 'shared',
      autoSplitType: null,
      txnType: 'purchase',
      amount: 50,
    }),
  );
  assert.ok(!result.flags.includes('missing_split'));
});

test('dedup backfill → likely_duplicate fires', () => {
  const result = computeImportConfidence(
    baseInput({ dedupDuplicateBackfilled: true }),
  );
  assert.ok(result.flags.includes('likely_duplicate'));
  assert.equal(result.state, 'needs_review');
});

test('refund linked to original → possible_refund_pair (informational, not blocking)', () => {
  const result = computeImportConfidence(
    baseInput({
      txnType: 'refund',
      linkedTransactionId: 42,
      amount: 25,
    }),
  );
  assert.ok(result.flags.includes('possible_refund_pair'));
  assert.equal(result.state, 'clean');
});

test('refund WITHOUT a linked sibling does NOT fire possible_refund_pair', () => {
  const result = computeImportConfidence(
    baseInput({
      txnType: 'refund',
      linkedTransactionId: null,
      amount: 25,
    }),
  );
  assert.ok(!result.flags.includes('possible_refund_pair'));
});

test('missingReceipt is informational, not blocking on its own', () => {
  const result = computeImportConfidence(baseInput({ missingReceipt: true }));
  assert.ok(result.flags.includes('missing_receipt'));
  // No blocking flag → still clean
  assert.equal(result.state, 'clean');
});

test('compound flags accumulate without overlap', () => {
  const result = computeImportConfidence(
    baseInput({
      reviewFlag: true,
      finalCategory: null,
      autoCategory: null,
      accountVisibility: 'shared',
      autoSplitType: null,
      dedupDuplicateBackfilled: true,
    }),
  );
  assert.equal(result.state, 'needs_review');
  assert.deepEqual(
    new Set(result.flags),
    new Set(['needs_review', 'missing_category', 'missing_split', 'likely_duplicate']),
  );
});

test('serializeFlags returns null for empty list', () => {
  assert.equal(serializeFlags([]), null);
});

test('serializeFlags round-trips through deserializeFlags', () => {
  const original = ['missing_category', 'needs_review'] as const;
  const serialized = serializeFlags([...original]);
  assert.equal(typeof serialized, 'string');
  const restored = deserializeFlags(serialized);
  assert.deepEqual(restored, [...original]);
});

test('deserializeFlags tolerates NULL', () => {
  assert.deepEqual(deserializeFlags(null), []);
});

test('deserializeFlags tolerates malformed JSON', () => {
  assert.deepEqual(deserializeFlags('not-json'), []);
  assert.deepEqual(deserializeFlags('"a string"'), []);
});

test('deserializeFlags drops unknown tokens', () => {
  const serialized = JSON.stringify(['missing_category', 'bogus_flag']);
  assert.deepEqual(deserializeFlags(serialized), ['missing_category']);
});

test('IMPORT_CONFIDENCE_FLAGS lists every documented flag', () => {
  // Sanity: if someone adds a flag to the union, they must add it to the
  // exported list so the API + UI can enumerate the allowed values.
  assert.ok(IMPORT_CONFIDENCE_FLAGS.includes('needs_review'));
  assert.ok(IMPORT_CONFIDENCE_FLAGS.includes('missing_category'));
  assert.ok(IMPORT_CONFIDENCE_FLAGS.includes('missing_split'));
  assert.ok(IMPORT_CONFIDENCE_FLAGS.includes('likely_duplicate'));
  assert.ok(IMPORT_CONFIDENCE_FLAGS.includes('possible_refund_pair'));
  assert.ok(IMPORT_CONFIDENCE_FLAGS.includes('missing_receipt'));
});
