/**
 * Unit tests for the FX-fee heuristic.
 *
 * Pure function — no DB, no network. Each test exercises one trigger.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectFxFee } from '../../src/fx/detectFxFee';

test('returns isFxFee=false when no signal present', () => {
  const result = detectFxFee({
    merchantRaw: 'Tim Hortons',
    merchantClean: 'Tim Hortons',
    notes: null,
    amount: -3.5,
    currency: 'CAD',
    accountDefaultCurrency: 'CAD',
  });
  assert.equal(result.isFxFee, false);
  assert.equal(result.reason, null);
});

test('detects explicit "FX FEE" in merchant text', () => {
  const result = detectFxFee({
    merchantRaw: 'VISA FX FEE',
    merchantClean: 'Visa Fx Fee',
    notes: null,
    amount: -1.23,
    currency: 'CAD',
    accountDefaultCurrency: 'CAD',
  });
  assert.equal(result.isFxFee, true);
  assert.equal(result.confidence, 'high');
  assert.match(result.reason ?? '', /fx_fee/i);
});

test('detects "FOREIGN CURRENCY CONVERSION" merchant', () => {
  const result = detectFxFee({
    merchantRaw: 'FOREIGN CURRENCY CONVERSION FEE',
    merchantClean: '',
    notes: null,
    amount: -2.5,
    currency: 'CAD',
    accountDefaultCurrency: 'CAD',
  });
  assert.equal(result.isFxFee, true);
  assert.equal(result.confidence, 'high');
});

test('detects "NON-CAD PURCHASE" tag', () => {
  const result = detectFxFee({
    merchantRaw: 'NON-CAD PURCHASE FEE',
    merchantClean: '',
    notes: null,
    amount: -0.75,
    currency: 'CAD',
    accountDefaultCurrency: 'CAD',
  });
  assert.equal(result.isFxFee, true);
});

test('detects fee in notes field', () => {
  const result = detectFxFee({
    merchantRaw: 'AMAZON.COM',
    merchantClean: 'Amazon',
    notes: 'Foreign transaction fee applied',
    amount: -1.05,
    currency: 'CAD',
    accountDefaultCurrency: 'CAD',
  });
  assert.equal(result.isFxFee, true);
});

test('flags as medium-confidence when txn currency mismatches account default and amount is tiny', () => {
  // A small USD txn on a CAD account, no explicit text — could be a fee.
  const result = detectFxFee({
    merchantRaw: 'BANK ADJUSTMENT',
    merchantClean: 'Bank Adjustment',
    notes: null,
    amount: -1.5,
    currency: 'USD',
    accountDefaultCurrency: 'CAD',
  });
  assert.equal(result.isFxFee, true);
  assert.equal(result.confidence, 'medium');
});

test('does not flag a normal-sized cross-currency purchase as a fee', () => {
  // A $50 USD purchase on a CAD account is just a foreign-currency
  // purchase — NOT a fee. The fee would be a separate small line.
  const result = detectFxFee({
    merchantRaw: 'AMAZON.COM',
    merchantClean: 'Amazon',
    notes: null,
    amount: -50,
    currency: 'USD',
    accountDefaultCurrency: 'CAD',
  });
  assert.equal(result.isFxFee, false);
});

test('does not flag when account default currency is null', () => {
  // No account default → can't infer fee from mismatch alone.
  const result = detectFxFee({
    merchantRaw: 'Coffee',
    merchantClean: 'Coffee',
    notes: null,
    amount: -1,
    currency: 'USD',
    accountDefaultCurrency: null,
  });
  assert.equal(result.isFxFee, false);
});

test('handles null merchant/notes gracefully', () => {
  const result = detectFxFee({
    merchantRaw: '',
    merchantClean: '',
    notes: null,
    amount: -5,
    currency: 'CAD',
    accountDefaultCurrency: 'CAD',
  });
  assert.equal(result.isFxFee, false);
});

test('explicit text wins over heuristic fallback', () => {
  // Even a $100 amount labeled "FX FEE" is high-confidence — text beats size.
  const result = detectFxFee({
    merchantRaw: 'BANK FX FEE',
    merchantClean: '',
    notes: null,
    amount: -100,
    currency: 'CAD',
    accountDefaultCurrency: 'CAD',
  });
  assert.equal(result.isFxFee, true);
  assert.equal(result.confidence, 'high');
});

test('detects EXCHANGE RATE FEE pattern', () => {
  const result = detectFxFee({
    merchantRaw: 'EXCHANGE RATE ADJUSTMENT',
    merchantClean: '',
    notes: null,
    amount: -0.5,
    currency: 'CAD',
    accountDefaultCurrency: 'CAD',
  });
  assert.equal(result.isFxFee, true);
});

test('detects CURRENCY CONVERSION pattern', () => {
  const result = detectFxFee({
    merchantRaw: 'CURRENCY CONVERSION CHARGE',
    merchantClean: '',
    notes: null,
    amount: -1.25,
    currency: 'CAD',
    accountDefaultCurrency: 'CAD',
  });
  assert.equal(result.isFxFee, true);
});

test('case-insensitive matching', () => {
  const result = detectFxFee({
    merchantRaw: 'visa fx fee',
    merchantClean: 'visa fx fee',
    notes: null,
    amount: -1,
    currency: 'CAD',
    accountDefaultCurrency: 'CAD',
  });
  assert.equal(result.isFxFee, true);
  assert.equal(result.confidence, 'high');
});

test('positive amounts (refunds) of fees still flag', () => {
  // A reversed fee should still be classifiable so users can see refunds.
  const result = detectFxFee({
    merchantRaw: 'FX FEE REVERSAL',
    merchantClean: '',
    notes: null,
    amount: 1.23,
    currency: 'CAD',
    accountDefaultCurrency: 'CAD',
  });
  assert.equal(result.isFxFee, true);
});
