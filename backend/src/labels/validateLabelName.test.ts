import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateLabelName, LABEL_NAME_MAX } from './validate';

test('trims surrounding whitespace and accepts a normal name', () => {
  const r = validateLabelName('  tax-deductible  ');
  assert.deepEqual(r, { ok: true, name: 'tax-deductible' });
});

test('rejects an empty string', () => {
  assert.deepEqual(validateLabelName(''), { ok: false, code: 'INVALID_LABEL_NAME' });
});

test('rejects whitespace-only (empty after trim)', () => {
  assert.deepEqual(validateLabelName('   '), { ok: false, code: 'INVALID_LABEL_NAME' });
});

test('rejects a non-string', () => {
  assert.deepEqual(validateLabelName(undefined), { ok: false, code: 'INVALID_LABEL_NAME' });
  assert.deepEqual(validateLabelName(42), { ok: false, code: 'INVALID_LABEL_NAME' });
  assert.deepEqual(validateLabelName(null), { ok: false, code: 'INVALID_LABEL_NAME' });
});

test('accepts exactly 32 characters', () => {
  const name = 'a'.repeat(LABEL_NAME_MAX);
  assert.deepEqual(validateLabelName(name), { ok: true, name });
});

test('rejects 33 characters', () => {
  const name = 'a'.repeat(LABEL_NAME_MAX + 1);
  assert.deepEqual(validateLabelName(name), { ok: false, code: 'INVALID_LABEL_NAME' });
});

test('counts length after trimming, so a 32-char core with surrounding spaces is valid', () => {
  const core = 'b'.repeat(LABEL_NAME_MAX);
  assert.deepEqual(validateLabelName(`  ${core}  `), { ok: true, name: core });
});
