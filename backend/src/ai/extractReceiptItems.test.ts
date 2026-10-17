import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SYSTEM_PROMPT, parseExtractedReceipt } from './extractReceiptItems';

test('the schema in the system prompt declares subtotal and tax', () => {
  assert.match(SYSTEM_PROMPT, /"subtotal":/);
  assert.match(SYSTEM_PROMPT, /"tax":/);
});

test('parseExtractedReceipt surfaces subtotal and tax when the model emits them', () => {
  const r = parseExtractedReceipt({ subtotal: 39.97, tax: 5.0, total: 44.97, items: [] });
  assert.equal(r.subtotal, 39.97);
  assert.equal(r.tax, 5.0);
});
