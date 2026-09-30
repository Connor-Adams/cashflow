import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priorPeriodAllowance } from './budgetSpend';

/**
 * `priorPeriodAllowance` is the pure half of the rollover computation: given a
 * budget's period, its creation timestamp and its target amount, it returns how
 * much allowance accumulated across the COMPLETED periods before the one
 * containing `now`, plus the earliest date the spend query has to reach.
 *
 * Carry is unclamped (an overspend propagates as a reduction with no floor), so
 * the per-period recursion collapses to
 *
 *     carryIn = priorAllowance - (spend across those prior periods)
 *
 * which is why this function only needs to return a single scalar rather than a
 * per-period series. See the PR description for the full decision record.
 */

const AMOUNT = 1000;

test('priorPeriodAllowance: a budget created in the current period has no prior periods', () => {
  const result = priorPeriodAllowance({
    period: 'monthly',
    now: new Date(2026, 0, 15),
    createdAt: new Date(2026, 0, 3),
    amount: AMOUNT,
  });
  assert.equal(result.priorPeriodCount, 0);
  assert.equal(result.priorAllowance, 0);
  // Nothing to reach back for: the query window is just the current period.
  assert.equal(result.anchorStart, '2026-01-01');
});

test('priorPeriodAllowance: three whole prior months accumulate three full allowances', () => {
  const result = priorPeriodAllowance({
    period: 'monthly',
    now: new Date(2026, 0, 15),
    // Created on the first day of October, so October is a whole period.
    createdAt: new Date(2025, 9, 1),
    amount: AMOUNT,
  });
  assert.equal(result.priorPeriodCount, 3); // Oct, Nov, Dec
  assert.equal(result.priorAllowance, 3000);
  assert.equal(result.anchorStart, '2025-10-01');
});

test('priorPeriodAllowance: the creation period is prorated by the days the budget existed', () => {
  const result = priorPeriodAllowance({
    period: 'monthly',
    now: new Date(2026, 0, 15),
    createdAt: new Date(2025, 11, 28),
    amount: AMOUNT,
  });
  assert.equal(result.priorPeriodCount, 1); // December only
  // Dec 28..Dec 31 inclusive is 4 of December's 31 days.
  assert.ok(
    Math.abs(result.priorAllowance - AMOUNT * (4 / 31)) < 1e-9,
    `expected ~${AMOUNT * (4 / 31)}, got ${result.priorAllowance}`,
  );
  assert.equal(result.anchorStart, '2025-12-01');
});

test('priorPeriodAllowance: a budget created mid-period gets no allowance for the day it was created onward only', () => {
  // Created on the LAST day of the period: 1 of 31 days.
  const result = priorPeriodAllowance({
    period: 'monthly',
    now: new Date(2026, 0, 15),
    createdAt: new Date(2025, 11, 31),
    amount: AMOUNT,
  });
  assert.equal(result.priorPeriodCount, 1);
  assert.ok(
    Math.abs(result.priorAllowance - AMOUNT * (1 / 31)) < 1e-9,
    `expected ~${AMOUNT / 31}, got ${result.priorAllowance}`,
  );
});

test('priorPeriodAllowance: lookback is capped at 12 prior periods', () => {
  // A weekly budget that has existed for two years would otherwise reach back
  // 104 periods; the cap bounds the transaction window.
  const result = priorPeriodAllowance({
    period: 'weekly',
    now: new Date(2026, 0, 15), // Thursday; ISO week starts Mon 2026-01-12
    createdAt: new Date(2024, 0, 3),
    amount: AMOUNT,
  });
  assert.equal(result.priorPeriodCount, 12);
  // The cap means the anchor period is NOT the creation period, so nothing is
  // prorated and every one of the 12 counts at full allowance.
  assert.equal(result.priorAllowance, 12000);
  // 12 weeks before Mon 2026-01-12 is Mon 2025-10-20.
  assert.equal(result.anchorStart, '2025-10-20');
});

test('priorPeriodAllowance: the 12-period cap is configurable', () => {
  const result = priorPeriodAllowance({
    period: 'monthly',
    now: new Date(2026, 0, 15),
    createdAt: new Date(2020, 0, 1),
    amount: AMOUNT,
    maxPeriods: 3,
  });
  assert.equal(result.priorPeriodCount, 3);
  assert.equal(result.priorAllowance, 3000);
  assert.equal(result.anchorStart, '2025-10-01');
});

test('priorPeriodAllowance: weekly periods walk back Monday to Monday', () => {
  const result = priorPeriodAllowance({
    period: 'weekly',
    now: new Date(2026, 0, 15), // week of Mon 2026-01-12
    createdAt: new Date(2025, 11, 29), // Mon 2025-12-29, a whole week
    amount: AMOUNT,
  });
  // Weeks of Dec 29, Jan 5 — two whole prior weeks.
  assert.equal(result.priorPeriodCount, 2);
  assert.equal(result.priorAllowance, 2000);
  assert.equal(result.anchorStart, '2025-12-29');
});

test('priorPeriodAllowance: annual periods prorate the creation year over 366 days in a leap year', () => {
  const result = priorPeriodAllowance({
    period: 'annual',
    now: new Date(2026, 5, 1),
    createdAt: new Date(2024, 2, 5), // 2024-03-05, day 65 of a 366-day year
    amount: AMOUNT,
  });
  assert.equal(result.priorPeriodCount, 2); // 2024 (partial) + 2025 (whole)
  // Mar 5..Dec 31 2024 inclusive = 366 - 65 + 1 = 302 days.
  const expected = AMOUNT * (302 / 366) + AMOUNT;
  assert.ok(
    Math.abs(result.priorAllowance - expected) < 1e-9,
    `expected ~${expected}, got ${result.priorAllowance}`,
  );
  assert.equal(result.anchorStart, '2024-01-01');
});

test('priorPeriodAllowance: a budget created before the capped window is not prorated', () => {
  // Creation predates the anchor entirely, so the anchor period is whole.
  const result = priorPeriodAllowance({
    period: 'monthly',
    now: new Date(2026, 0, 15),
    createdAt: new Date(2019, 4, 17),
    amount: AMOUNT,
  });
  assert.equal(result.priorPeriodCount, 12);
  assert.equal(result.priorAllowance, 12000);
  assert.equal(result.anchorStart, '2025-01-01');
});

test('priorPeriodAllowance: a creation timestamp later in the current period still yields no carry', () => {
  // Guards against an off-by-one that would treat the current period as prior.
  const result = priorPeriodAllowance({
    period: 'monthly',
    now: new Date(2026, 0, 31),
    createdAt: new Date(2026, 0, 31),
    amount: AMOUNT,
  });
  assert.equal(result.priorPeriodCount, 0);
  assert.equal(result.priorAllowance, 0);
  assert.equal(result.anchorStart, '2026-01-01');
});
