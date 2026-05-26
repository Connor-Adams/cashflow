/**
 * Unit tests for the pure projection utility used by GET /api/goals/:id/projection
 * and the upcoming safe-to-spend feature (issue #199). Uses an injected `today`
 * to keep the math deterministic without freezing the system clock.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  projectGoal,
  requiredMonthlyContributionsByCurrency,
  type GoalSnapshot,
} from '../../src/goals/projection.js';

function goal(overrides: Partial<GoalSnapshot> = {}): GoalSnapshot {
  return {
    id: 1,
    name: 'Emergency fund',
    targetAmount: '10000',
    currentAmount: '0',
    currency: 'CAD',
    targetDate: null,
    monthlyContribution: null,
    status: 'active',
    createdAt: '2026-01-01',
    ...overrides,
  };
}

test('projectGoal: completed goal short-circuits to onTrackStatus="completed"', () => {
  const result = projectGoal(
    goal({ status: 'completed', currentAmount: '10000', targetAmount: '10000' }),
    '2026-05-26',
  );
  assert.equal(result.onTrackStatus, 'completed');
  assert.equal(result.requiredMonthlyContribution, null);
  assert.equal(result.monthsRemaining, null);
  assert.equal(result.projectedCompletionDate, null);
});

test('projectGoal: paused goal reports "paused" status with null required', () => {
  const result = projectGoal(
    goal({ status: 'paused', targetDate: '2027-01-01', currentAmount: '500' }),
    '2026-05-26',
  );
  assert.equal(result.onTrackStatus, 'paused');
  assert.equal(result.requiredMonthlyContribution, null);
});

test('projectGoal: no target_date returns "no_deadline"', () => {
  const result = projectGoal(goal({ targetDate: null }), '2026-05-26');
  assert.equal(result.onTrackStatus, 'no_deadline');
  assert.equal(result.monthsRemaining, null);
  assert.equal(result.requiredMonthlyContribution, null);
  assert.equal(result.expectedAmountToday, null);
});

test('projectGoal: target_date in past with target not hit → overdue', () => {
  const result = projectGoal(
    goal({ targetDate: '2026-01-01', currentAmount: '5000', targetAmount: '10000' }),
    '2026-05-26',
  );
  assert.equal(result.onTrackStatus, 'overdue');
  assert.equal(result.monthsRemaining, 0);
  // Required contribution is the remaining amount (can't spread further) — surfaces urgency.
  assert.equal(result.requiredMonthlyContribution, '5000.0000');
});

test('projectGoal: target_date in past with target met → completed', () => {
  const result = projectGoal(
    goal({ targetDate: '2026-01-01', currentAmount: '10000', targetAmount: '10000' }),
    '2026-05-26',
  );
  assert.equal(result.onTrackStatus, 'completed');
  assert.equal(result.requiredMonthlyContribution, null);
});

test('projectGoal: required = (target - current) / monthsRemaining', () => {
  // Today 2026-05-26, target 2027-05-26 → 12 months remaining.
  // target 12000, current 0 → required = 1000/mo
  const result = projectGoal(
    goal({ targetDate: '2027-05-26', targetAmount: '12000', currentAmount: '0' }),
    '2026-05-26',
  );
  assert.equal(result.monthsRemaining, 12);
  assert.equal(result.requiredMonthlyContribution, '1000.0000');
});

test('projectGoal: months remaining rounds DOWN to whole months', () => {
  // 2026-05-26 → 2027-05-25 is 11 months + 30 days = 11 full months
  const result = projectGoal(
    goal({ targetDate: '2027-05-25', targetAmount: '11000', currentAmount: '0' }),
    '2026-05-26',
  );
  assert.equal(result.monthsRemaining, 11);
  assert.equal(result.requiredMonthlyContribution, '1000.0000');
});

test('projectGoal: monthsRemaining for same-month target_date is 0 → overdue-like math', () => {
  const result = projectGoal(
    goal({ targetDate: '2026-05-30', targetAmount: '5000', currentAmount: '0' }),
    '2026-05-26',
  );
  assert.equal(result.monthsRemaining, 0);
  assert.equal(result.requiredMonthlyContribution, '5000.0000');
});

test('projectGoal: expectedAmountToday with linear pace from createdAt', () => {
  // Goal created 2026-01-01, target 2027-01-01 (~365 days), target 1200.
  // At exactly midpoint 2026-07-02 (~half year), expected ~600.
  // Use 2026-07-02: 182 days elapsed of ~365 → 1200 * (182/365) ≈ 598.36
  const result = projectGoal(
    goal({
      createdAt: '2026-01-01',
      targetDate: '2027-01-01',
      targetAmount: '1200',
      currentAmount: '600',
    }),
    '2026-07-02',
  );
  // Within tolerance of the linear glide-path midpoint (±5%); 600 is on_track.
  assert.ok(
    result.expectedAmountToday != null &&
      Number(result.expectedAmountToday) > 590 &&
      Number(result.expectedAmountToday) < 610,
    `expected ~600, got ${result.expectedAmountToday}`,
  );
  assert.equal(result.onTrackStatus, 'on_track');
});

test('projectGoal: current ahead of expected → "ahead"', () => {
  const result = projectGoal(
    goal({
      createdAt: '2026-01-01',
      targetDate: '2027-01-01',
      targetAmount: '1200',
      currentAmount: '900',
    }),
    '2026-07-01',
  );
  assert.equal(result.onTrackStatus, 'ahead');
  // Expected at 6/12 mo elapsed = 600; current 900 = ahead.
});

test('projectGoal: current behind expected → "behind"', () => {
  const result = projectGoal(
    goal({
      createdAt: '2026-01-01',
      targetDate: '2027-01-01',
      targetAmount: '1200',
      currentAmount: '300',
    }),
    '2026-07-01',
  );
  assert.equal(result.onTrackStatus, 'behind');
});

test('projectGoal: tolerance — within 5% of expected counts as on_track', () => {
  // expected 600, current 580 (3.3% short) → on_track
  const result = projectGoal(
    goal({
      createdAt: '2026-01-01',
      targetDate: '2027-01-01',
      targetAmount: '1200',
      currentAmount: '580',
    }),
    '2026-07-01',
  );
  assert.equal(result.onTrackStatus, 'on_track');
});

test('projectGoal: projectedCompletionDate based on monthly_contribution if set', () => {
  // Need 1000 more, monthly_contribution 100 → 10 months → 2026-12-26 from 2026-02-26
  const result = projectGoal(
    goal({
      currentAmount: '0',
      targetAmount: '1000',
      monthlyContribution: '100',
      targetDate: '2027-01-01', // far enough out that monthly_contribution dominates
      createdAt: '2026-02-26',
    }),
    '2026-02-26',
  );
  assert.equal(result.projectedCompletionDate, '2026-12-26');
});

test('projectGoal: projectedCompletionDate null when no contribution and no deadline', () => {
  const result = projectGoal(
    goal({ targetDate: null, monthlyContribution: null }),
    '2026-05-26',
  );
  assert.equal(result.projectedCompletionDate, null);
});

test('projectGoal: progressPercent always between 0 and 100', () => {
  const overfunded = projectGoal(
    goal({ currentAmount: '15000', targetAmount: '10000' }),
    '2026-05-26',
  );
  assert.equal(overfunded.progressPercent, 100);

  const negative = projectGoal(
    goal({ currentAmount: '-50', targetAmount: '10000' }),
    '2026-05-26',
  );
  assert.equal(negative.progressPercent, 0);

  const half = projectGoal(
    goal({ currentAmount: '5000', targetAmount: '10000' }),
    '2026-05-26',
  );
  assert.equal(half.progressPercent, 50);
});

test('projectGoal: zero target_amount returns 100% complete', () => {
  // Degenerate but should not divide by zero.
  const result = projectGoal(
    goal({ currentAmount: '0', targetAmount: '0' }),
    '2026-05-26',
  );
  assert.equal(result.progressPercent, 100);
  assert.equal(result.onTrackStatus, 'completed');
});

// ---- requiredMonthlyContributionsByCurrency ------------------------------

test('requiredMonthlyContributionsByCurrency: groups by currency, sums required', () => {
  const goals: GoalSnapshot[] = [
    goal({
      id: 1,
      currency: 'CAD',
      targetDate: '2027-05-26',
      targetAmount: '12000',
      currentAmount: '0',
    }), // 12 mo → 1000/mo CAD
    goal({
      id: 2,
      currency: 'CAD',
      targetDate: '2026-11-26',
      targetAmount: '600',
      currentAmount: '0',
    }), // 6 mo → 100/mo CAD
    goal({
      id: 3,
      currency: 'USD',
      targetDate: '2027-05-26',
      targetAmount: '3600',
      currentAmount: '0',
    }), // 12 mo → 300/mo USD
  ];
  const result = requiredMonthlyContributionsByCurrency(goals, '2026-05-26');
  assert.equal(result.CAD, '1100.0000');
  assert.equal(result.USD, '300.0000');
});

test('requiredMonthlyContributionsByCurrency: ignores paused, completed, no_deadline', () => {
  const goals: GoalSnapshot[] = [
    goal({
      id: 1,
      status: 'paused',
      currency: 'CAD',
      targetDate: '2027-05-26',
      targetAmount: '12000',
      currentAmount: '0',
    }),
    goal({
      id: 2,
      status: 'completed',
      currency: 'CAD',
      targetDate: '2027-05-26',
      targetAmount: '12000',
      currentAmount: '12000',
    }),
    goal({
      id: 3,
      status: 'active',
      currency: 'CAD',
      targetDate: null,
      targetAmount: '5000',
      currentAmount: '0',
    }),
  ];
  const result = requiredMonthlyContributionsByCurrency(goals, '2026-05-26');
  assert.deepEqual(result, {});
});

test('requiredMonthlyContributionsByCurrency: empty input returns empty object', () => {
  const result = requiredMonthlyContributionsByCurrency([], '2026-05-26');
  assert.deepEqual(result, {});
});
