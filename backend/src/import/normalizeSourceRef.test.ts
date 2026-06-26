/**
 * Tests for normalizeSourceRef.
 *
 * Prod bug: the Amex statement import stored some source references wrapped in
 * literal single quotes ('AT26…') and others bare (AT26…). Dedup keys on the
 * raw reference, so a re-import producing the bare form never matched the stored
 * quoted twin → duplicate transactions slipped in (a doubled $6,236.10 payment
 * corrupted the card balance). The reference must be normalized — surrounding
 * quotes stripped — on both the stored side and the dedup-compare side.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSourceRef } from './normalizeSourceRef';

test('strips surrounding single quotes', () => {
  assert.equal(normalizeSourceRef("'AT261650003000010000555'"), 'AT261650003000010000555');
});

test('strips surrounding double quotes', () => {
  assert.equal(normalizeSourceRef('"AT26"'), 'AT26');
});

test('leaves an unquoted reference unchanged', () => {
  assert.equal(normalizeSourceRef('AT261650003000010000555'), 'AT261650003000010000555');
});

test('a quoted and an unquoted form normalize to the same value (dedup-equal)', () => {
  assert.equal(
    normalizeSourceRef("'AT26'"),
    normalizeSourceRef('AT26'),
  );
});

test('trims whitespace outside the quotes', () => {
  assert.equal(normalizeSourceRef("  'AT26'  "), 'AT26');
});

test('strips doubled/nested surrounding quotes', () => {
  assert.equal(normalizeSourceRef(`"'AT26'"`), 'AT26');
});

test('preserves quotes that are not a surrounding pair', () => {
  assert.equal(normalizeSourceRef("AT'26"), "AT'26");
});

test('null, undefined, empty, and quotes-only collapse to null', () => {
  assert.equal(normalizeSourceRef(null), null);
  assert.equal(normalizeSourceRef(undefined), null);
  assert.equal(normalizeSourceRef(''), null);
  assert.equal(normalizeSourceRef("''"), null);
});
