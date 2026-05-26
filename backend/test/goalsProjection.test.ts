import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectGoal } from '../src/goals/projection.js';

test('projection: completed when current >= target', () => {
  const p = projectGoal({
    targetAmount: '1000.0000',
    currentAmount: '1000.0000',
    targetDate: '2026-12-31',
    monthlyContribution: '100.0000',
    today: '2026-06-01',
  });
  assert.equal(p.status, 'completed');
  assert.equal(p.remainingAmount, '0.0000');
  assert.equal(p.progressPercent, 100);
  assert.equal(p.requiredMonthlyContribution, null);
  assert.equal(p.projectedCompletionDate, null);
});

test('projection: completed when current > target (over-funded)', () => {
  const p = projectGoal({
    targetAmount: '500.0000',
    currentAmount: '750.0000',
    targetDate: null,
    monthlyContribution: null,
    today: '2026-06-01',
  });
  assert.equal(p.status, 'completed');
  assert.equal(p.progressPercent, 100);
});

test('projection: unfunded when target_date set but no monthly_contribution', () => {
  // Target $1200 on 2027-06-01, today 2026-06-01 => 12 months; required ~$100/mo
  const p = projectGoal({
    targetAmount: '1200.0000',
    currentAmount: '0.0000',
    targetDate: '2027-06-01',
    monthlyContribution: null,
    today: '2026-06-01',
  });
  assert.equal(p.status, 'unfunded');
  assert.equal(p.monthsRemaining, 12);
  assert.equal(p.requiredMonthlyContribution, '100.0000');
  assert.equal(p.projectedCompletionDate, null);
});

test('projection: on_track when contribution within 10% of required', () => {
  // Required = $100/mo; contribution = $100/mo
  const p = projectGoal({
    targetAmount: '1200.0000',
    currentAmount: '0.0000',
    targetDate: '2027-06-01',
    monthlyContribution: '100.0000',
    today: '2026-06-01',
  });
  assert.equal(p.status, 'on_track');
  assert.equal(p.requiredMonthlyContribution, '100.0000');
  assert.equal(p.projectedCompletionDate, '2027-06-01');
});

test('projection: ahead when contribution >= 110% of required', () => {
  // Required = $100/mo; contribution = $150/mo
  const p = projectGoal({
    targetAmount: '1200.0000',
    currentAmount: '0.0000',
    targetDate: '2027-06-01',
    monthlyContribution: '150.0000',
    today: '2026-06-01',
  });
  assert.equal(p.status, 'ahead');
  // 1200/150 = 8 months => 2027-02-01
  assert.equal(p.projectedCompletionDate, '2027-02-01');
});

test('projection: behind when contribution < 90% of required', () => {
  // Required = $100/mo; contribution = $50/mo
  const p = projectGoal({
    targetAmount: '1200.0000',
    currentAmount: '0.0000',
    targetDate: '2027-06-01',
    monthlyContribution: '50.0000',
    today: '2026-06-01',
  });
  assert.equal(p.status, 'behind');
  // 1200/50 = 24 months => 2028-06-01
  assert.equal(p.projectedCompletionDate, '2028-06-01');
});

test('projection: active when neither target_date nor monthly_contribution set', () => {
  const p = projectGoal({
    targetAmount: '5000.0000',
    currentAmount: '500.0000',
    targetDate: null,
    monthlyContribution: null,
    today: '2026-06-01',
  });
  assert.equal(p.status, 'active');
  assert.equal(p.remainingAmount, '4500.0000');
  assert.equal(p.monthsRemaining, null);
  assert.equal(p.requiredMonthlyContribution, null);
  assert.equal(p.projectedCompletionDate, null);
  assert.equal(p.progressPercent, 10);
});

test('projection: active with projection when monthly_contribution but no target_date', () => {
  const p = projectGoal({
    targetAmount: '1000.0000',
    currentAmount: '0.0000',
    targetDate: null,
    monthlyContribution: '100.0000',
    today: '2026-06-01',
  });
  assert.equal(p.status, 'active');
  assert.equal(p.requiredMonthlyContribution, null);
  // 1000/100 = 10 months => 2027-04-01
  assert.equal(p.projectedCompletionDate, '2027-04-01');
});

test('projection: partial progress percent computed correctly', () => {
  const p = projectGoal({
    targetAmount: '4000.0000',
    currentAmount: '1000.0000',
    targetDate: null,
    monthlyContribution: null,
    today: '2026-06-01',
  });
  assert.equal(p.progressPercent, 25);
  assert.equal(p.remainingAmount, '3000.0000');
});

test('projection: zero target produces 0% progress without divide-by-zero', () => {
  const p = projectGoal({
    targetAmount: '0.0000',
    currentAmount: '0.0000',
    targetDate: null,
    monthlyContribution: null,
    today: '2026-06-01',
  });
  assert.equal(p.progressPercent, 0);
  assert.equal(p.remainingAmount, '0.0000');
  assert.equal(p.status, 'completed');
});

test('projection: target_date in past produces 0 months remaining, required = full remaining', () => {
  // Past deadline: monthsBetween clamps to 0, divisor floors at 1, so
  // required = remaining (i.e. "you need to fully fund this *this month*").
  const p = projectGoal({
    targetAmount: '1000.0000',
    currentAmount: '0.0000',
    targetDate: '2026-01-01',
    monthlyContribution: null,
    today: '2026-06-01',
  });
  assert.equal(p.monthsRemaining, 0);
  assert.equal(p.requiredMonthlyContribution, '1000.0000');
  assert.equal(p.status, 'unfunded');
});

test('projection: invalid target_date treated like null', () => {
  const p = projectGoal({
    targetAmount: '1000.0000',
    currentAmount: '0.0000',
    targetDate: 'not-a-date',
    monthlyContribution: '100.0000',
    today: '2026-06-01',
  });
  assert.equal(p.monthsRemaining, null);
  assert.equal(p.requiredMonthlyContribution, null);
  // Still produces a projected completion since monthly_contribution is set.
  assert.equal(p.projectedCompletionDate, '2027-04-01');
  assert.equal(p.status, 'active');
});

test('projection: negative current_amount clamped to 0 progress', () => {
  const p = projectGoal({
    targetAmount: '1000.0000',
    currentAmount: '-50.0000',
    targetDate: null,
    monthlyContribution: null,
    today: '2026-06-01',
  });
  assert.equal(p.progressPercent, 0);
  // Remaining = max(0, target - current) = max(0, 1000 - (-50)) = 1050
  assert.equal(p.remainingAmount, '1050.0000');
});
