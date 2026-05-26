/**
 * Unit tests for the pure helpers in `src/budgets/budgetBreachCheck.ts`
 * (issue #268). The cron's IO-heavy bits (Sequelize queries, the notification
 * helper) are exercised in the integration test. Here we pin down behavior
 * that doesn't need a DB:
 *
 *   - `periodKey` returns the dedup key for monthly/weekly/annual budgets.
 *   - `selectThresholdsToFire` reports newly-crossed thresholds correctly.
 *   - `budgetBreachTitle` / `budgetBreachBody` produce the spec'd copy.
 *   - `remainingDaysInPeriod` reports inclusive days left.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  periodKey,
  selectThresholdsToFire,
  budgetBreachTitle,
  budgetBreachBody,
  remainingDaysInPeriod,
} from '../src/budgets/budgetBreachCheck';
import { validateAlertThresholds } from '../src/routes/budgets';

// ---- periodKey --------------------------------------------------------------

test('periodKey: monthly returns YYYY-MM', () => {
  // 0-indexed month in JS Date; May 14 2026 = month 4
  const d = new Date(2026, 4, 14, 8, 0, 0);
  assert.equal(periodKey('monthly', d), '2026-05');
});

test('periodKey: monthly pads single-digit months', () => {
  const d = new Date(2026, 0, 3, 8, 0, 0);
  assert.equal(periodKey('monthly', d), '2026-01');
});

test('periodKey: weekly uses ISO week numbers', () => {
  // Mon May 18 2026 is ISO week 21 (year 2026, Monday).
  const d = new Date(Date.UTC(2026, 4, 18, 12, 0, 0));
  assert.equal(periodKey('weekly', d), '2026-W21');
});

test('periodKey: annual returns YYYY', () => {
  const d = new Date(2026, 4, 18, 8, 0, 0);
  assert.equal(periodKey('annual', d), '2026');
});

test('periodKey: same monthly key holds for every day in May', () => {
  for (let dayOfMonth = 1; dayOfMonth <= 31; dayOfMonth++) {
    const d = new Date(2026, 4, dayOfMonth, 12, 0, 0);
    assert.equal(periodKey('monthly', d), '2026-05');
  }
});

// ---- selectThresholdsToFire ------------------------------------------------

test('selectThresholdsToFire: below the lowest threshold returns []', () => {
  assert.deepEqual(
    selectThresholdsToFire([80, 100, 120], 70, new Set()),
    [],
  );
});

test('selectThresholdsToFire: at exactly 80 fires the 80 threshold', () => {
  assert.deepEqual(
    selectThresholdsToFire([80, 100, 120], 80, new Set()),
    [80],
  );
});

test('selectThresholdsToFire: between 80 and 100 fires only 80', () => {
  assert.deepEqual(
    selectThresholdsToFire([80, 100, 120], 92, new Set()),
    [80],
  );
});

test('selectThresholdsToFire: at 100 fires 80 and 100 if neither alerted yet', () => {
  assert.deepEqual(
    selectThresholdsToFire([80, 100, 120], 100, new Set()),
    [80, 100],
  );
});

test('selectThresholdsToFire: at 130 fires all three if none alerted yet', () => {
  assert.deepEqual(
    selectThresholdsToFire([80, 100, 120], 130, new Set()),
    [80, 100, 120],
  );
});

test('selectThresholdsToFire: thresholds already alerted are not re-fired', () => {
  assert.deepEqual(
    selectThresholdsToFire([80, 100, 120], 130, new Set([80, 100])),
    [120],
  );
});

test('selectThresholdsToFire: result is sorted ascending even from unsorted input', () => {
  assert.deepEqual(
    selectThresholdsToFire([120, 80, 100], 130, new Set()),
    [80, 100, 120],
  );
});

test('selectThresholdsToFire: custom thresholds outside default set still fire', () => {
  // Some users will configure e.g. [50, 90, 110] — assert we honor that.
  assert.deepEqual(
    selectThresholdsToFire([50, 90, 110], 95, new Set()),
    [50, 90],
  );
});

test('selectThresholdsToFire: thresholds removed from config never fire', () => {
  // User had [80, 100, 120] but removed 80 — re-fire 100 only.
  assert.deepEqual(
    selectThresholdsToFire([100, 120], 110, new Set()),
    [100],
  );
});

// ---- budgetBreachTitle / budgetBreachBody ----------------------------------

test('budgetBreachTitle: 80 threshold uses approaching phrasing', () => {
  assert.equal(
    budgetBreachTitle('Groceries', 80),
    "You've used 80% of your Groceries budget",
  );
});

test('budgetBreachTitle: 100 threshold says "reached"', () => {
  assert.equal(budgetBreachTitle('Groceries', 100), 'Groceries budget reached');
});

test('budgetBreachTitle: 120 threshold reports the over percentage', () => {
  assert.equal(
    budgetBreachTitle('Groceries', 120),
    'Groceries budget exceeded by 20%',
  );
});

test('budgetBreachTitle: null category becomes "Overall"', () => {
  assert.equal(budgetBreachTitle(null, 100), 'Overall budget reached');
});

test('budgetBreachBody: CAD shows $ prefix', () => {
  const body = budgetBreachBody({
    spent: 322,
    target: 400,
    currency: 'CAD',
    period: 'monthly',
    remainingDays: 12,
  });
  assert.equal(body, '$322.00 of $400.00 this month. 12 days left.');
});

test('budgetBreachBody: non-USD/CAD uses suffix form', () => {
  const body = budgetBreachBody({
    spent: 80,
    target: 100,
    currency: 'EUR',
    period: 'monthly',
    remainingDays: 5,
  });
  // Each amount carries its own EUR suffix — the rendered body keeps the
  // currency visible on both spent and target so a multi-currency user
  // reading the bell can't confuse which row belongs to which budget.
  assert.equal(body, '80.00 EUR of 100.00 EUR this month. 5 days left.');
});

test('budgetBreachBody: 1 day uses singular form', () => {
  const body = budgetBreachBody({
    spent: 100,
    target: 100,
    currency: 'CAD',
    period: 'monthly',
    remainingDays: 1,
  });
  assert.match(body, /1 day left\./);
});

test('budgetBreachBody: 0 days says period ends today', () => {
  const body = budgetBreachBody({
    spent: 100,
    target: 100,
    currency: 'CAD',
    period: 'monthly',
    remainingDays: 0,
  });
  assert.match(body, /Period ends today\./);
});

test('budgetBreachBody: weekly switches to "week"', () => {
  const body = budgetBreachBody({
    spent: 50,
    target: 100,
    currency: 'CAD',
    period: 'weekly',
    remainingDays: 3,
  });
  assert.match(body, /this week/);
});

test('budgetBreachBody: annual switches to "year"', () => {
  const body = budgetBreachBody({
    spent: 1200,
    target: 2400,
    currency: 'CAD',
    period: 'annual',
    remainingDays: 200,
  });
  assert.match(body, /this year/);
});

// ---- remainingDaysInPeriod -------------------------------------------------

test('remainingDaysInPeriod: midway through May leaves >1 day', () => {
  const now = new Date(2026, 4, 14, 12, 0, 0); // May 14 noon
  const days = remainingDaysInPeriod(now, {
    periodStart: '2026-05-01',
    periodEnd: '2026-05-31',
  });
  assert.ok(days >= 17 && days <= 18, `got ${days}, expected 17-18`);
});

test('remainingDaysInPeriod: after period ends returns 0', () => {
  const now = new Date(2026, 5, 1, 12, 0, 0); // June 1 noon
  const days = remainingDaysInPeriod(now, {
    periodStart: '2026-05-01',
    periodEnd: '2026-05-31',
  });
  assert.equal(days, 0);
});

// ---- validateAlertThresholds -----------------------------------------------

test('validateAlertThresholds: undefined returns defaults [80,100,120]', () => {
  const result = validateAlertThresholds(undefined);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value, [80, 100, 120]);
});

test('validateAlertThresholds: accepts custom thresholds', () => {
  const result = validateAlertThresholds([50, 75, 90]);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value, [50, 75, 90]);
});

test('validateAlertThresholds: empty array is allowed (disables alerts)', () => {
  const result = validateAlertThresholds([]);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value, []);
});

test('validateAlertThresholds: dedupes + sorts', () => {
  const result = validateAlertThresholds([100, 80, 100, 120]);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value, [80, 100, 120]);
});

test('validateAlertThresholds: rejects non-array', () => {
  const result = validateAlertThresholds('80,100');
  assert.equal(result.ok, false);
});

test('validateAlertThresholds: rejects zero', () => {
  const result = validateAlertThresholds([0, 100]);
  assert.equal(result.ok, false);
});

test('validateAlertThresholds: rejects > 500', () => {
  const result = validateAlertThresholds([100, 600]);
  assert.equal(result.ok, false);
});

test('validateAlertThresholds: rejects non-integer', () => {
  const result = validateAlertThresholds([80.5]);
  assert.equal(result.ok, false);
});

test('validateAlertThresholds: rejects NaN / non-numeric strings', () => {
  const result = validateAlertThresholds(['abc']);
  assert.equal(result.ok, false);
});
