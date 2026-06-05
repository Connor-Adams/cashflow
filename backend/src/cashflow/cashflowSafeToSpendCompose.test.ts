/**
 * Pure tests for `composeSafeToSpend` (issue #199).
 *
 * Exercises the math + toggle semantics without touching the DB. Pairs with
 * `cashflowSettingsValidate.test.ts` for the route validator coverage and
 * `integration/cashflowSafeToSpend.test.ts` for the end-to-end DB path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeSafeToSpend } from './safeToSpend';

function baseInput() {
  return {
    currency: 'CAD',
    asOfDate: '2026-06-01',
    windowDays: 14,
    windowEndDate: '2026-06-15',
    currentCash: 3000,
    upcomingRequiredExpenses: 800,
    requiredSavingsContributions: 200,
    expectedCreditCardPayments: 300,
    minimumBuffer: 100,
    settings: {
      minimumCashBuffer: '100.0000',
      safeToSpendWindowDays: 14,
      includeCreditCardBalance: true,
      includeGoalContributions: true,
    },
  };
}

test('composeSafeToSpend: full deduction yields cash minus all line items', () => {
  const r = composeSafeToSpend(baseInput());
  assert.equal(r.value, 1600);
  assert.equal(r.isNegative, false);
  assert.equal(r.breakdown.currentCash, 3000);
  assert.equal(r.breakdown.upcomingRequiredExpenses, 800);
  assert.equal(r.breakdown.requiredSavingsContributions, 200);
  assert.equal(r.breakdown.expectedCreditCardPayments, 300);
  assert.equal(r.breakdown.minimumBuffer, 100);
});

test('composeSafeToSpend: includeCreditCardBalance=false zeroes out CC line', () => {
  const input = baseInput();
  input.settings.includeCreditCardBalance = false;
  const r = composeSafeToSpend(input);
  // 3000 - 800 - 200 - 0 - 100 = 1900
  assert.equal(r.value, 1900);
  assert.equal(r.breakdown.expectedCreditCardPayments, 0);
});

test('composeSafeToSpend: includeGoalContributions=false zeroes out savings line', () => {
  const input = baseInput();
  input.settings.includeGoalContributions = false;
  const r = composeSafeToSpend(input);
  // 3000 - 800 - 0 - 300 - 100 = 1800
  assert.equal(r.value, 1800);
  assert.equal(r.breakdown.requiredSavingsContributions, 0);
});

test('composeSafeToSpend: both toggles off only deducts expenses and buffer', () => {
  const input = baseInput();
  input.settings.includeCreditCardBalance = false;
  input.settings.includeGoalContributions = false;
  const r = composeSafeToSpend(input);
  // 3000 - 800 - 0 - 0 - 100 = 2100
  assert.equal(r.value, 2100);
});

test('composeSafeToSpend: produces a negative value when deductions exceed cash', () => {
  const input = baseInput();
  input.currentCash = 200;
  const r = composeSafeToSpend(input);
  // 200 - 800 - 200 - 300 - 100 = -1200
  assert.equal(r.value, -1200);
  assert.equal(r.isNegative, true);
});

test('composeSafeToSpend: zero buffer is honored', () => {
  const input = baseInput();
  input.minimumBuffer = 0;
  const r = composeSafeToSpend(input);
  // 3000 - 800 - 200 - 300 - 0 = 1700
  assert.equal(r.value, 1700);
  assert.equal(r.breakdown.minimumBuffer, 0);
});

test('composeSafeToSpend: rounds money fields to 2 decimal places', () => {
  const input = baseInput();
  input.currentCash = 1000.456789;
  input.upcomingRequiredExpenses = 100.111111;
  input.requiredSavingsContributions = 50.555555;
  input.expectedCreditCardPayments = 0;
  input.minimumBuffer = 0;
  const r = composeSafeToSpend(input);
  // 1000.456789 - 100.111111 - 50.555555 - 0 - 0 = 849.790123 → 849.79
  assert.equal(r.value, 849.79);
  assert.equal(r.breakdown.currentCash, 1000.46);
  assert.equal(r.breakdown.upcomingRequiredExpenses, 100.11);
  assert.equal(r.breakdown.requiredSavingsContributions, 50.56);
});

test('composeSafeToSpend: NaN/non-finite inputs round to 0 in breakdown', () => {
  const input = baseInput();
  input.currentCash = NaN;
  const r = composeSafeToSpend(input);
  // breakdown.currentCash should be 0 (round2 guards Number.isFinite)
  assert.equal(r.breakdown.currentCash, 0);
});

test('composeSafeToSpend: echoes settings booleans back to caller', () => {
  const input = baseInput();
  input.settings.includeCreditCardBalance = false;
  input.settings.includeGoalContributions = true;
  const r = composeSafeToSpend(input);
  assert.equal(r.settings.includeCreditCardBalance, false);
  assert.equal(r.settings.includeGoalContributions, true);
  assert.equal(r.settings.minimumCashBuffer, '100.0000');
  assert.equal(r.settings.safeToSpendWindowDays, 14);
});

test('composeSafeToSpend: echoes window metadata back to caller', () => {
  const input = baseInput();
  input.windowDays = 30;
  input.windowEndDate = '2026-07-01';
  input.asOfDate = '2026-06-01';
  const r = composeSafeToSpend(input);
  assert.equal(r.currency, 'CAD');
  assert.equal(r.asOfDate, '2026-06-01');
  assert.equal(r.windowDays, 30);
  assert.equal(r.windowEndDate, '2026-07-01');
});
