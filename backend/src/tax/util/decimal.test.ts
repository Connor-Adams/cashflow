import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D, sumD } from './decimal';

test('D constructs from string and number', () => {
  assert.equal(D('1.23').toFixed(2), '1.23');
  assert.equal(D(1.23).toFixed(2), '1.23');
});

test('sumD adds an array preserving precision', () => {
  assert.equal(sumD(['0.1', '0.2']).toFixed(2), '0.30');
});
