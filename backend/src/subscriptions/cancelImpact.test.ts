/**
 * Unit tests for the pure cancel-impact helpers (Cashflow #291).
 *
 * Cancel-impact projects how much a user would spend on a subscription over
 * a forecast horizon at its current cadence, so the UI can show "Cancelling
 * saves you $X over the next N months" before they cancel.
 *
 * Integration coverage (HTTP route, DB scoping, validation) lives in
 * test/integration/subscriptions.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOWED_HORIZON_MONTHS,
  computeCancelImpact,
  isAllowedHorizon,
  periodsPerYear,
} from './cancelImpact';
import { SUBSCRIPTION_CADENCES } from '../models/PlannedEvent';

test('ALLOWED_HORIZON_MONTHS is exactly {6, 12, 24}', () => {
  assert.deepEqual([...ALLOWED_HORIZON_MONTHS], [6, 12, 24]);
});

test('isAllowedHorizon accepts 6, 12, 24 and rejects everything else', () => {
  assert.equal(isAllowedHorizon(6), true);
  assert.equal(isAllowedHorizon(12), true);
  assert.equal(isAllowedHorizon(24), true);
  assert.equal(isAllowedHorizon(1), false);
  assert.equal(isAllowedHorizon(18), false);
  assert.equal(isAllowedHorizon(0), false);
  assert.equal(isAllowedHorizon(-12), false);
  assert.equal(isAllowedHorizon(12.5), false);
  assert.equal(isAllowedHorizon(Number.NaN), false);
});

test('periodsPerYear maps each cadence to its annual occurrence count', () => {
  assert.equal(periodsPerYear('weekly'), 52);
  assert.equal(periodsPerYear('monthly'), 12);
  assert.equal(periodsPerYear('quarterly'), 4);
  assert.equal(periodsPerYear('semiannual'), 2);
  assert.equal(periodsPerYear('annual'), 1);
});

test('periodsPerYear covers every cadence in SUBSCRIPTION_CADENCES', () => {
  for (const cadence of SUBSCRIPTION_CADENCES) {
    assert.ok(
      periodsPerYear(cadence) > 0,
      `periodsPerYear should be defined for ${cadence}`,
    );
  }
});

// ----- AC #5 canonical numeric cases -----

test('monthly $20 over 12 months → amount 240, count 12 (AC #5)', () => {
  const impact = computeCancelImpact({
    perPeriodAmount: 20,
    cadence: 'monthly',
    horizonMonths: 12,
  });
  assert.equal(impact.amount, 240);
  assert.equal(impact.count, 12);
  assert.equal(impact.horizonMonths, 12);
});

test('annual $120 over 12 months → amount 120, count 1 (AC #5)', () => {
  const impact = computeCancelImpact({
    perPeriodAmount: 120,
    cadence: 'annual',
    horizonMonths: 12,
  });
  assert.equal(impact.amount, 120);
  assert.equal(impact.count, 1);
});

// ----- other cadences over various horizons -----

test('quarterly $30 over 12 months → amount 120, count 4', () => {
  const impact = computeCancelImpact({
    perPeriodAmount: 30,
    cadence: 'quarterly',
    horizonMonths: 12,
  });
  assert.equal(impact.count, 4);
  assert.equal(impact.amount, 120);
});

test('semiannual $50 over 24 months → amount 200, count 4', () => {
  const impact = computeCancelImpact({
    perPeriodAmount: 50,
    cadence: 'semiannual',
    horizonMonths: 24,
  });
  assert.equal(impact.count, 4);
  assert.equal(impact.amount, 200);
});

test('annual $120 over 24 months → amount 240, count 2', () => {
  const impact = computeCancelImpact({
    perPeriodAmount: 120,
    cadence: 'annual',
    horizonMonths: 24,
  });
  assert.equal(impact.count, 2);
  assert.equal(impact.amount, 240);
});

test('monthly $20 over 6 months → amount 120, count 6', () => {
  const impact = computeCancelImpact({
    perPeriodAmount: 20,
    cadence: 'monthly',
    horizonMonths: 6,
  });
  assert.equal(impact.count, 6);
  assert.equal(impact.amount, 120);
});

test('weekly $10 over 12 months → count 52, amount 520', () => {
  // 52 weeks per year * (12/12) = 52 occurrences.
  const impact = computeCancelImpact({
    perPeriodAmount: 10,
    cadence: 'weekly',
    horizonMonths: 12,
  });
  assert.equal(impact.count, 52);
  assert.equal(impact.amount, 520);
});

test('weekly $10 over 6 months → count 26, amount 260', () => {
  // 52 * (6/12) = 26 occurrences.
  const impact = computeCancelImpact({
    perPeriodAmount: 10,
    cadence: 'weekly',
    horizonMonths: 6,
  });
  assert.equal(impact.count, 26);
  assert.equal(impact.amount, 260);
});

test('quarterly $30 over 6 months → count 2, amount 60', () => {
  // 4 per year * (6/12) = 2 occurrences.
  const impact = computeCancelImpact({
    perPeriodAmount: 30,
    cadence: 'quarterly',
    horizonMonths: 6,
  });
  assert.equal(impact.count, 2);
  assert.equal(impact.amount, 60);
});

// ----- rounding + sign normalization -----

test('amount is rounded to two decimals', () => {
  // 9.99 monthly * 12 = 119.88 — already 2dp, but check a value that needs rounding.
  const impact = computeCancelImpact({
    perPeriodAmount: 9.999,
    cadence: 'monthly',
    horizonMonths: 12,
  });
  // 9.999 * 12 = 119.988 → 119.99
  assert.equal(impact.amount, 119.99);
});

test('negative per-period amount is treated as a positive spend', () => {
  // Charges are stored as negative numbers per the codebase convention; the
  // impact figure is a positive amount of savings.
  const impact = computeCancelImpact({
    perPeriodAmount: -20,
    cadence: 'monthly',
    horizonMonths: 12,
  });
  assert.equal(impact.amount, 240);
  assert.equal(impact.count, 12);
});

test('weekly occurrence count is rounded to a whole number over 24 months', () => {
  // 52 * (24/12) = 104 — exact, no rounding artifact.
  const impact = computeCancelImpact({
    perPeriodAmount: 5,
    cadence: 'weekly',
    horizonMonths: 24,
  });
  assert.equal(impact.count, 104);
  assert.equal(impact.amount, 520);
});
