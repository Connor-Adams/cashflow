/**
 * Unit tests for the pure label color validator (issue #794). No DB — exercises
 * validateLabelColor directly so the hex rule and the optional/null handling are
 * covered without a Postgres integration run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateLabelColor } from '../src/labels/validate.js';

test('validateLabelColor accepts a 6-digit hex string', () => {
  const r = validateLabelColor('#3B82F6');
  assert.deepEqual(r, { ok: true, color: '#3B82F6' });
});

test('validateLabelColor treats undefined, null, and empty string as no color', () => {
  for (const raw of [undefined, null, '']) {
    const r = validateLabelColor(raw);
    assert.deepEqual(r, { ok: true, color: null }, `raw=${String(raw)}`);
  }
});

test('validateLabelColor rejects non-hex strings with INVALID_COLOR', () => {
  for (const raw of ['blue', '#FFF', '#1234567', 'FF0000', '#GGGGGG', '#12345']) {
    const r = validateLabelColor(raw);
    assert.deepEqual(r, { ok: false, code: 'INVALID_COLOR' }, `raw=${String(raw)}`);
  }
});

test('validateLabelColor rejects non-string, non-null values with INVALID_COLOR', () => {
  for (const raw of [123, {}, [], true]) {
    const r = validateLabelColor(raw);
    assert.deepEqual(r, { ok: false, code: 'INVALID_COLOR' }, `raw=${String(raw)}`);
  }
});
