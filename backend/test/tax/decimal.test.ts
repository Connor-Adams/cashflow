import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D, sumD, toCents, fromCents } from '../../src/tax/util/decimal';

test('D constructs from string and number', () => {
  assert.equal(D('1.23').toFixed(2), '1.23');
  assert.equal(D(1.23).toFixed(2), '1.23');
});

test('sumD adds an array preserving precision', () => {
  assert.equal(sumD(['0.1', '0.2']).toFixed(2), '0.30');
});

test('toCents / fromCents round-trip', () => {
  assert.equal(toCents(D('123.45')), 12345);
  assert.equal(fromCents(12345).toFixed(2), '123.45');
});
