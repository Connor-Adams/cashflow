import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVendor } from '../src/ai/extractReceiptItems';

test('parseVendor accepts uber and uber_eats', () => {
  assert.equal(parseVendor('uber'), 'uber');
  assert.equal(parseVendor('uber_eats'), 'uber_eats');
});
test('parseVendor keeps existing vendors and falls back to other', () => {
  assert.equal(parseVendor('apple'), 'apple');
  assert.equal(parseVendor('costco'), 'costco');
  assert.equal(parseVendor('nonsense'), 'other');
});
