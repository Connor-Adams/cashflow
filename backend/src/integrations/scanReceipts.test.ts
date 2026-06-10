import { test } from 'node:test';
import assert from 'node:assert/strict';
import { receiptCurrencyOrDefault } from './scanReceipts';
import { defaultCurrency } from '../config/env';

test('receiptCurrencyOrDefault keeps an extracted currency', () => {
  assert.equal(receiptCurrencyOrDefault('USD'), 'USD');
  assert.equal(receiptCurrencyOrDefault('CAD'), 'CAD');
});

test('receiptCurrencyOrDefault falls back to the app default currency, never a hardcoded USD', () => {
  // AI extraction legitimately returns currency null; fabricating 'USD' in a
  // CAD-default app made scoreCurrencyComponent apply its -40 penalty against
  // every CAD transaction, killing otherwise-perfect receipt matches.
  assert.equal(receiptCurrencyOrDefault(null), defaultCurrency);
  assert.equal(receiptCurrencyOrDefault(undefined), defaultCurrency);
});
