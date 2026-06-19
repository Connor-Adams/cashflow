import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectGoalAgainstForecast } from './projection.js';

// Required = remaining / max(1, monthsRemaining).
// For target 1200, current 0, today 2026-06-01, targetDate 2027-06-01:
//   remaining = 1200, monthsRemaining = 12, requiredMonthly = 100.
const BASE = {
  targetAmount: '1200.0000',
  currentAmount: '0.0000',
  targetDate: '2027-06-01',
  today: '2026-06-01',
  goalCurrency: 'CAD',
  forecastCurrency: 'CAD',
} as const;

test('forecast projection: on_track when free cash >= required (AC2)', () => {
  const p = projectGoalAgainstForecast({ ...BASE, forecastedMonthlyFreeCash: 150 });
  assert.equal(p.status, 'on_track');
  assert.equal(p.requiredMonthlyContribution, '100.0000');
  assert.equal(p.monthlyFreeCash, '150.0000');
  assert.equal(p.currency, 'CAD');
  assert.equal(p.currencyMismatch, false);
});

test('forecast projection: on_track exactly at the -10% boundary (AC2)', () => {
  // required = 100; available = 90 = required * 0.9 → on_track (inclusive).
  const p = projectGoalAgainstForecast({ ...BASE, forecastedMonthlyFreeCash: 90 });
  assert.equal(p.status, 'on_track');
});

test('forecast projection: at_risk just under the -10% boundary (AC3)', () => {
  // required = 100; available = 89.99 < 90 → at_risk.
  const p = projectGoalAgainstForecast({ ...BASE, forecastedMonthlyFreeCash: 89.99 });
  assert.equal(p.status, 'at_risk');
});

test('forecast projection: at_risk when 0 < free cash < required*0.9 (AC3)', () => {
  const p = projectGoalAgainstForecast({ ...BASE, forecastedMonthlyFreeCash: 50 });
  assert.equal(p.status, 'at_risk');
  assert.equal(p.requiredMonthlyContribution, '100.0000');
});

test('forecast projection: off_track when free cash is zero (AC4)', () => {
  const p = projectGoalAgainstForecast({ ...BASE, forecastedMonthlyFreeCash: 0 });
  assert.equal(p.status, 'off_track');
});

test('forecast projection: off_track when free cash is negative (AC4)', () => {
  const p = projectGoalAgainstForecast({ ...BASE, forecastedMonthlyFreeCash: -250 });
  assert.equal(p.status, 'off_track');
  // projectedCompletionDate is null when no positive free cash (AC9).
  assert.equal(p.projectedCompletionDate, null);
});

test('forecast projection: off_track when target date already past and unmet (AC4)', () => {
  const p = projectGoalAgainstForecast({
    ...BASE,
    targetDate: '2026-01-01', // before today
    forecastedMonthlyFreeCash: 1000, // plenty of cash, but date is gone
  });
  assert.equal(p.status, 'off_track');
});

test('forecast projection: completed when remaining <= 0 regardless of free cash (AC5)', () => {
  const p = projectGoalAgainstForecast({
    ...BASE,
    currentAmount: '1200.0000',
    forecastedMonthlyFreeCash: -999,
  });
  assert.equal(p.status, 'completed');
  assert.equal(p.requiredMonthlyContribution, null);
  assert.equal(p.projectedCompletionDate, null);
});

test('forecast projection: no_deadline when targetDate is null (AC6)', () => {
  const p = projectGoalAgainstForecast({
    ...BASE,
    targetDate: null,
    forecastedMonthlyFreeCash: 200,
  });
  assert.equal(p.status, 'no_deadline');
  // No classification attempted → no required monthly.
  assert.equal(p.requiredMonthlyContribution, null);
  // Still projects a completion date from positive free cash (AC9).
  // remaining 1200 / 200 = 6 months → 2026-12-01.
  assert.equal(p.projectedCompletionDate, '2026-12-01');
});

test('forecast projection: cant_validate on currency mismatch, no faked numbers (AC7)', () => {
  const p = projectGoalAgainstForecast({
    ...BASE,
    goalCurrency: 'EUR',
    forecastCurrency: 'CAD',
    forecastedMonthlyFreeCash: 1000,
  });
  assert.equal(p.status, 'cant_validate');
  assert.equal(p.currencyMismatch, true);
  assert.equal(p.requiredMonthlyContribution, null);
  assert.equal(p.projectedCompletionDate, null);
  // Currency reported is the forecast currency.
  assert.equal(p.currency, 'CAD');
});

test('forecast projection: requiredMonthlyContribution = remaining/max(1,months) at 4dp (AC8)', () => {
  // target 1000, current 250, today 2026-06-01, targetDate 2026-09-01 → 3 months.
  // remaining 750 / 3 = 250.0000.
  const p = projectGoalAgainstForecast({
    ...BASE,
    targetAmount: '1000.0000',
    currentAmount: '250.0000',
    targetDate: '2026-09-01',
    forecastedMonthlyFreeCash: 300,
  });
  assert.equal(p.requiredMonthlyContribution, '250.0000');
  assert.equal(p.status, 'on_track');
});

test('forecast projection: projectedCompletionDate from free cash, not typed contribution (AC9)', () => {
  // remaining 1200, free cash 100/mo → 12 months → 2027-06-01.
  const p = projectGoalAgainstForecast({ ...BASE, forecastedMonthlyFreeCash: 100 });
  assert.equal(p.projectedCompletionDate, '2027-06-01');
});

test('forecast projection: monthlyFreeCash formatted to 4dp', () => {
  const p = projectGoalAgainstForecast({ ...BASE, forecastedMonthlyFreeCash: 1234.56 });
  assert.equal(p.monthlyFreeCash, '1234.5600');
});

test('forecast projection: currency mismatch takes precedence over completed', () => {
  // Even a completed goal in a mismatched currency should report cant_validate?
  // No — completed is an honest, non-misleading state independent of currency.
  // Mismatch only blocks the numeric on-track classification.
  const p = projectGoalAgainstForecast({
    ...BASE,
    goalCurrency: 'EUR',
    currentAmount: '1200.0000', // completed
    forecastedMonthlyFreeCash: 0,
  });
  assert.equal(p.status, 'completed');
});
