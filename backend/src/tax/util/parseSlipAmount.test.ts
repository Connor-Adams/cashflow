import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSlipAmount } from './parseSlipAmount';

test('plain numbers and numeric strings parse', () => {
  assert.equal(parseSlipAmount(1200.5)?.toFixed(2), '1200.50');
  assert.equal(parseSlipAmount('1200.50')?.toFixed(2), '1200.50');
});

test('thousands separators and a dollar sign parse', () => {
  assert.equal(parseSlipAmount('1,200.50')?.toFixed(2), '1200.50');
  assert.equal(parseSlipAmount(' $61,200 ')?.toFixed(2), '61200.00');
});

test('non-numbers are rejected, not guessed', () => {
  assert.equal(parseSlipAmount('12a'), null);
  assert.equal(parseSlipAmount(''), null);
  assert.equal(parseSlipAmount(null), null);
  assert.equal(parseSlipAmount(Number.NaN), null);
  assert.equal(parseSlipAmount({}), null);
});
