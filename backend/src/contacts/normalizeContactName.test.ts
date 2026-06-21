import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeContactName } from './normalizeContactName.js';

test('lowercases and collapses whitespace', () => {
  assert.equal(normalizeContactName('  JANE   DOE '), 'jane doe');
});
test('null/empty -> null', () => {
  assert.equal(normalizeContactName(null), null);
  assert.equal(normalizeContactName('   '), null);
});
test('casing variants collapse to the same key', () => {
  assert.equal(normalizeContactName('Jane Doe'), normalizeContactName('JANE DOE'));
});
