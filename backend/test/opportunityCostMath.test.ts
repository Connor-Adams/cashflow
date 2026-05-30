/**
 * Unit tests for the opportunity-cost future-value math (issue #252).
 *
 * Pure functions, no DB. Covers:
 *  - one-time compound growth: amount * (1 + r)^t
 *  - recurring end-of-period annuity: C * ((1 + i)^n - 1) / i
 *  - zero-rate edge cases (no divide-by-zero, FV == contributions)
 *  - cadence -> periods-per-year mapping
 *  - the input validator
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeOpportunityCost,
  validateOpportunityCostInput,
  CADENCE_PERIODS_PER_YEAR,
  type OpportunityCostInput,
} from '../src/cashflow/opportunityCost.js';

/** Round to cents — the result fields are intentionally cent-rounded for display. */
function cents(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Compare against a cent-rounded expectation. The math functions round their
 * monetary outputs to cents, so we compare to the same precision; the small
 * epsilon only guards against floating-point representation of the cent value.
 */
function approx(actual: number, expected: number, eps = 1e-6): void {
  const target = cents(expected);
  assert.ok(
    Math.abs(actual - target) <= eps,
    `expected ${actual} to be within ${eps} of ${target} (cent-rounded from ${expected})`
  );
}

test('one-time: compound future value over whole years', () => {
  const res = computeOpportunityCost({
    mode: 'one-time',
    amount: 1000,
    horizonYears: 10,
    annualReturnRate: 0.07,
  });
  // 1000 * 1.07^10 = 1967.151357...
  approx(res.futureValue, 1000 * Math.pow(1.07, 10));
  approx(res.totalContributions, 1000);
  approx(res.gain, 1000 * Math.pow(1.07, 10) - 1000);
  assert.equal(res.mode, 'one-time');
});

test('one-time: zero return rate yields no growth', () => {
  const res = computeOpportunityCost({
    mode: 'one-time',
    amount: 500,
    horizonYears: 5,
    annualReturnRate: 0,
  });
  approx(res.futureValue, 500);
  approx(res.totalContributions, 500);
  approx(res.gain, 0);
});

test('one-time: fractional horizon compounds continuously by exponent', () => {
  const res = computeOpportunityCost({
    mode: 'one-time',
    amount: 1000,
    horizonYears: 2.5,
    annualReturnRate: 0.05,
  });
  approx(res.futureValue, 1000 * Math.pow(1.05, 2.5));
});

test('recurring monthly: end-of-period annuity future value', () => {
  const monthlyContribution = 200;
  const horizonYears = 10;
  const annualReturnRate = 0.06;
  const res = computeOpportunityCost({
    mode: 'recurring',
    amount: monthlyContribution,
    cadence: 'monthly',
    horizonYears,
    annualReturnRate,
  });

  const i = annualReturnRate / 12;
  const n = 12 * horizonYears;
  const expectedFv = monthlyContribution * ((Math.pow(1 + i, n) - 1) / i);

  approx(res.futureValue, expectedFv, 1e-4);
  approx(res.totalContributions, monthlyContribution * n);
  approx(res.gain, expectedFv - monthlyContribution * n, 1e-4);
  // Monthly contribution, so monthlyEquivalent equals the contribution.
  approx(res.monthlyEquivalent, monthlyContribution);
});

test('recurring weekly: monthlyEquivalent normalizes 52 weekly to monthly', () => {
  const weekly = 50;
  const res = computeOpportunityCost({
    mode: 'recurring',
    amount: weekly,
    cadence: 'weekly',
    horizonYears: 1,
    annualReturnRate: 0.04,
  });
  // 50/week * 52 weeks / 12 months = 216.6666...
  approx(res.monthlyEquivalent, (weekly * 52) / 12);
  approx(res.totalContributions, weekly * 52);
});

test('recurring: zero rate yields FV equal to total contributions', () => {
  const res = computeOpportunityCost({
    mode: 'recurring',
    amount: 100,
    cadence: 'monthly',
    horizonYears: 3,
    annualReturnRate: 0,
  });
  approx(res.futureValue, 100 * 36);
  approx(res.totalContributions, 100 * 36);
  approx(res.gain, 0);
});

test('recurring: quarterly and annual cadences map periods correctly', () => {
  assert.equal(CADENCE_PERIODS_PER_YEAR.quarterly, 4);
  assert.equal(CADENCE_PERIODS_PER_YEAR.annual, 1);
  assert.equal(CADENCE_PERIODS_PER_YEAR.biweekly, 26);

  const quarterly = computeOpportunityCost({
    mode: 'recurring',
    amount: 300,
    cadence: 'quarterly',
    horizonYears: 2,
    annualReturnRate: 0,
  });
  approx(quarterly.totalContributions, 300 * 8);
});

test('result includes human-readable assumptions describing rate, horizon, cadence', () => {
  const res = computeOpportunityCost({
    mode: 'recurring',
    amount: 250,
    cadence: 'monthly',
    horizonYears: 5,
    annualReturnRate: 0.08,
  });
  assert.ok(Array.isArray(res.assumptions));
  assert.ok(res.assumptions.length >= 1);
  const joined = res.assumptions.join(' ').toLowerCase();
  assert.match(joined, /8(\.0+)?%/); // return rate surfaced
  assert.match(joined, /5\b/); // horizon surfaced
  assert.match(joined, /month/); // cadence surfaced
});

test('result echoes back the resolved inputs', () => {
  const input: OpportunityCostInput = {
    mode: 'recurring',
    amount: 250,
    cadence: 'monthly',
    horizonYears: 5,
    annualReturnRate: 0.08,
  };
  const res = computeOpportunityCost(input);
  assert.equal(res.amount, 250);
  assert.equal(res.cadence, 'monthly');
  assert.equal(res.horizonYears, 5);
  assert.equal(res.annualReturnRate, 0.08);
});

test('validator accepts a well-formed one-time payload', () => {
  const out = validateOpportunityCostInput({
    mode: 'one-time',
    amount: 1000,
    horizonYears: 10,
    annualReturnRate: 0.07,
  });
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.value.mode, 'one-time');
    assert.equal(out.value.amount, 1000);
    // cadence defaults are irrelevant for one-time but must not throw.
  }
});

test('validator accepts string-numeric inputs and coerces them', () => {
  const out = validateOpportunityCostInput({
    mode: 'recurring',
    amount: '250.50',
    cadence: 'monthly',
    horizonYears: '5',
    annualReturnRate: '0.08',
  });
  assert.equal(out.ok, true);
  if (out.ok) {
    approx(out.value.amount, 250.5);
    approx(out.value.horizonYears, 5);
    approx(out.value.annualReturnRate, 0.08);
  }
});

test('validator rejects non-positive amount', () => {
  const out = validateOpportunityCostInput({
    mode: 'one-time',
    amount: 0,
    horizonYears: 10,
    annualReturnRate: 0.07,
  });
  assert.equal(out.ok, false);
});

test('validator rejects non-positive horizon', () => {
  const out = validateOpportunityCostInput({
    mode: 'one-time',
    amount: 100,
    horizonYears: 0,
    annualReturnRate: 0.07,
  });
  assert.equal(out.ok, false);
});

test('validator rejects an unknown mode', () => {
  const out = validateOpportunityCostInput({
    mode: 'forever',
    amount: 100,
    horizonYears: 10,
    annualReturnRate: 0.07,
  });
  assert.equal(out.ok, false);
});

test('validator rejects an unknown cadence for recurring', () => {
  const out = validateOpportunityCostInput({
    mode: 'recurring',
    amount: 100,
    cadence: 'fortnightly',
    horizonYears: 10,
    annualReturnRate: 0.07,
  });
  assert.equal(out.ok, false);
});

test('validator rejects an absurd horizon and return rate (bounds)', () => {
  const tooLong = validateOpportunityCostInput({
    mode: 'one-time',
    amount: 100,
    horizonYears: 1000,
    annualReturnRate: 0.07,
  });
  assert.equal(tooLong.ok, false);

  const tooHigh = validateOpportunityCostInput({
    mode: 'one-time',
    amount: 100,
    horizonYears: 10,
    annualReturnRate: 10, // 1000%
  });
  assert.equal(tooHigh.ok, false);

  const negativeRate = validateOpportunityCostInput({
    mode: 'one-time',
    amount: 100,
    horizonYears: 10,
    annualReturnRate: -0.5,
  });
  assert.equal(negativeRate.ok, false);
});
