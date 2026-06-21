import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCategoryName } from './normalizeName';

test('normalizeCategoryName trims and lowercases', () => {
  assert.equal(normalizeCategoryName('  Internet '), 'internet');
  assert.equal(normalizeCategoryName('INTERNET'), 'internet');
  assert.equal(normalizeCategoryName('Internet'), 'internet');
});

test('normalizeCategoryName collapses casing variants to one key', () => {
  const keys = new Set(['Internet', 'internet', 'INTERNET'].map(normalizeCategoryName));
  assert.equal(keys.size, 1);
});
