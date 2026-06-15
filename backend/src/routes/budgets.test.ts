import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateBudgetInput,
  validateBudgetPatch,
  aggregateSpendByCategory,
  computeBudgetProgress,
  netRefundsFromSpend,
  currentMonthBounds,
  currentPeriodBounds,
  periodElapsedPercent,
  pacingState,
} from './budgets';

// ---- validateBudgetInput ------------------------------------------------

test('validateBudgetInput: rejects zero amount', () => {
  const result = validateBudgetInput({
    category: 'Groceries',
    currency: 'CAD',
    amount: 0,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 400);
    assert.match(result.error, /amount must be a positive number/);
  }
});

test('validateBudgetInput: rejects negative amount', () => {
  const result = validateBudgetInput({
    category: 'Groceries',
    currency: 'CAD',
    amount: -10,
  });
  assert.equal(result.ok, false);
});

test('validateBudgetInput: rejects non-numeric amount', () => {
  const result = validateBudgetInput({
    category: 'Groceries',
    currency: 'CAD',
    amount: 'big',
  });
  assert.equal(result.ok, false);
});

test('validateBudgetInput: rejects missing currency', () => {
  const result = validateBudgetInput({
    category: 'Groceries',
    amount: 50,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /3-letter ISO code/);
});

test('validateBudgetInput: rejects bad currency length', () => {
  const result = validateBudgetInput({
    category: 'Groceries',
    currency: 'USDS',
    amount: 50,
  });
  assert.equal(result.ok, false);
});

test('validateBudgetInput: normalizes currency to uppercase', () => {
  const result = validateBudgetInput({
    category: 'Groceries',
    currency: 'cad',
    amount: 100,
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.currency, 'CAD');
});

test('validateBudgetInput: null category preserved as null (overall)', () => {
  const result = validateBudgetInput({
    category: null,
    currency: 'CAD',
    amount: 1000,
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.category, null);
});

test('validateBudgetInput: empty-string category coerces to null', () => {
  const result = validateBudgetInput({
    category: '  ',
    currency: 'CAD',
    amount: 1000,
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.category, null);
});

test('validateBudgetInput: trims and preserves category', () => {
  const result = validateBudgetInput({
    category: '  Groceries  ',
    currency: 'CAD',
    amount: 200,
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.category, 'Groceries');
});

test('validateBudgetInput: defaults period to monthly', () => {
  const result = validateBudgetInput({
    category: 'Groceries',
    currency: 'CAD',
    amount: 200,
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.period, 'monthly');
});

test('validateBudgetInput: rejects unknown period', () => {
  const result = validateBudgetInput({
    category: 'Groceries',
    currency: 'CAD',
    amount: 200,
    period: 'fortnightly',
  });
  assert.equal(result.ok, false);
});

test('validateBudgetInput: formats amount to 4 decimal places', () => {
  const result = validateBudgetInput({
    category: 'Groceries',
    currency: 'CAD',
    amount: 12.5,
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.amount, '12.5000');
});

// ---- validateBudgetPatch ------------------------------------------------

test('validateBudgetPatch: empty body ok and yields no changes', () => {
  const result = validateBudgetPatch({});
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value, {});
});

test('validateBudgetPatch: rejects zero amount when provided', () => {
  const result = validateBudgetPatch({ amount: 0 });
  assert.equal(result.ok, false);
});

test('validateBudgetPatch: keeps `category: null` patch as null (overall)', () => {
  const result = validateBudgetPatch({ category: null });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.category, null);
});

test('validateBudgetPatch: rejects bad currency', () => {
  const result = validateBudgetPatch({ currency: 'CADS' });
  assert.equal(result.ok, false);
});

// ---- issue #215: excludeRefundedPurchases ----

test('validateBudgetInput: excludeRefundedPurchases defaults to false', () => {
  const result = validateBudgetInput({
    category: 'Groceries',
    currency: 'CAD',
    amount: 100,
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.excludeRefundedPurchases, false);
});

test('validateBudgetInput: excludeRefundedPurchases=true is parsed', () => {
  const result = validateBudgetInput({
    category: 'Groceries',
    currency: 'CAD',
    amount: 100,
    excludeRefundedPurchases: true,
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.excludeRefundedPurchases, true);
});

test('validateBudgetInput: accepts string "true" for excludeRefundedPurchases', () => {
  const result = validateBudgetInput({
    category: 'Groceries',
    currency: 'CAD',
    amount: 100,
    excludeRefundedPurchases: 'true',
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.excludeRefundedPurchases, true);
});

test('validateBudgetPatch: excludeRefundedPurchases=false is recorded explicitly', () => {
  const result = validateBudgetPatch({ excludeRefundedPurchases: false });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.excludeRefundedPurchases, false);
});

// ---- aggregateSpendByCategory ------------------------------------------

test('aggregateSpendByCategory: charges are summed as positive spend', () => {
  const out = aggregateSpendByCategory([
    { currency: 'CAD', finalCategory: 'Groceries', amount: -25.5 },
    { currency: 'CAD', finalCategory: 'Groceries', amount: -10 },
  ]);
  const entry = out.get('CAD\0Groceries');
  assert.ok(entry);
  assert.equal(entry!.spent, 35.5);
});

test('aggregateSpendByCategory: positive amounts (credits/refunds/payments) are ignored', () => {
  const out = aggregateSpendByCategory([
    { currency: 'CAD', finalCategory: 'Groceries', amount: 30 },
    { currency: 'CAD', finalCategory: 'Groceries', amount: -5 },
  ]);
  const entry = out.get('CAD\0Groceries');
  assert.ok(entry);
  assert.equal(entry!.spent, 5);
});

test('aggregateSpendByCategory: null category is preserved as its own bucket', () => {
  const out = aggregateSpendByCategory([
    { currency: 'CAD', finalCategory: null, amount: -7 },
  ]);
  const entry = out.get('CAD\0');
  assert.ok(entry);
  assert.equal(entry!.category, null);
  assert.equal(entry!.spent, 7);
});

test('aggregateSpendByCategory: different currencies are kept separate', () => {
  const out = aggregateSpendByCategory([
    { currency: 'CAD', finalCategory: 'Travel', amount: -100 },
    { currency: 'USD', finalCategory: 'Travel', amount: -50 },
  ]);
  assert.equal(out.size, 2);
  assert.equal(out.get('CAD\0Travel')!.spent, 100);
  assert.equal(out.get('USD\0Travel')!.spent, 50);
});

// ---- netRefundsFromSpend -----------------------------------------------

test('netRefundsFromSpend: a PARTIAL refund nets only the refunded amount', () => {
  // $100 purchase in Groceries, $30 refunded → spend should drop to $70,
  // NOT to $0 (the old "exclude whole original purchase" behaviour).
  const spend = aggregateSpendByCategory([
    { currency: 'CAD', finalCategory: 'Groceries', amount: -100 },
  ]);
  netRefundsFromSpend(spend, [
    { amount: 30, currency: 'CAD', category: 'Groceries' },
  ]);
  assert.equal(spend.get('CAD\0Groceries')!.spent, 70);
});

test('netRefundsFromSpend: a FULL refund zeroes the original spend', () => {
  const spend = aggregateSpendByCategory([
    { currency: 'CAD', finalCategory: 'Groceries', amount: -200 },
    { currency: 'CAD', finalCategory: 'Groceries', amount: -80 },
  ]);
  netRefundsFromSpend(spend, [
    { amount: 200, currency: 'CAD', category: 'Groceries' },
  ]);
  // 280 - 200 = 80
  assert.equal(spend.get('CAD\0Groceries')!.spent, 80);
});

test('netRefundsFromSpend: over-refund clamps the bucket at 0 (never negative)', () => {
  const spend = aggregateSpendByCategory([
    { currency: 'CAD', finalCategory: 'Groceries', amount: -50 },
  ]);
  netRefundsFromSpend(spend, [
    { amount: 80, currency: 'CAD', category: 'Groceries' },
  ]);
  assert.equal(spend.get('CAD\0Groceries')!.spent, 0);
});

test('netRefundsFromSpend: refund matches on (currency, category) — others untouched', () => {
  const spend = aggregateSpendByCategory([
    { currency: 'CAD', finalCategory: 'Groceries', amount: -100 },
    { currency: 'CAD', finalCategory: 'Travel', amount: -60 },
    { currency: 'USD', finalCategory: 'Groceries', amount: -40 },
  ]);
  netRefundsFromSpend(spend, [
    { amount: 25, currency: 'CAD', category: 'Groceries' },
  ]);
  assert.equal(spend.get('CAD\0Groceries')!.spent, 75);
  assert.equal(spend.get('CAD\0Travel')!.spent, 60);
  assert.equal(spend.get('USD\0Groceries')!.spent, 40);
});

test('netRefundsFromSpend: null-category refund nets the null bucket', () => {
  const spend = aggregateSpendByCategory([
    { currency: 'CAD', finalCategory: null, amount: -40 },
  ]);
  netRefundsFromSpend(spend, [
    { amount: 15, currency: 'CAD', category: null },
  ]);
  assert.equal(spend.get('CAD\0')!.spent, 25);
});

test('netRefundsFromSpend: refund with no matching bucket is a no-op', () => {
  const spend = aggregateSpendByCategory([
    { currency: 'CAD', finalCategory: 'Groceries', amount: -100 },
  ]);
  netRefundsFromSpend(spend, [
    { amount: 30, currency: 'CAD', category: 'Dining' },
  ]);
  assert.equal(spend.get('CAD\0Groceries')!.spent, 100);
  assert.equal(spend.has('CAD\0Dining'), false);
});

// ---- computeBudgetProgress ---------------------------------------------

test('computeBudgetProgress: per-category budget reads its own bucket', () => {
  const bounds = { periodStart: '2026-05-01', periodEnd: '2026-05-31' };
  const items = computeBudgetProgress(
    [
      {
        id: 1,
        category: 'Groceries',
        currency: 'CAD',
        amount: '400.0000',
      },
    ],
    new Map([
      [
        'CAD\0Groceries',
        { currency: 'CAD', category: 'Groceries', spent: 120 },
      ],
      [
        'CAD\0Rent',
        { currency: 'CAD', category: 'Rent', spent: 2000 },
      ],
    ]),
    bounds
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].spent, 120);
  assert.equal(items[0].target, 400);
  assert.equal(items[0].remaining, 280);
  assert.equal(items[0].percentUsed, (120 / 400) * 100);
  assert.equal(items[0].periodStart, '2026-05-01');
  assert.equal(items[0].periodEnd, '2026-05-31');
});

test('computeBudgetProgress: overall budget (category=null) sums every category in that currency', () => {
  const bounds = { periodStart: '2026-05-01', periodEnd: '2026-05-31' };
  const items = computeBudgetProgress(
    [{ id: 2, category: null, currency: 'CAD', amount: '3000.0000' }],
    new Map([
      ['CAD\0Groceries', { currency: 'CAD', category: 'Groceries', spent: 120 }],
      ['CAD\0Rent', { currency: 'CAD', category: 'Rent', spent: 2000 }],
      ['USD\0Travel', { currency: 'USD', category: 'Travel', spent: 500 }],
    ]),
    bounds
  );
  assert.equal(items[0].spent, 2120);
  assert.equal(items[0].target, 3000);
});

test('computeBudgetProgress: percentUsed > 100 when overspent', () => {
  const bounds = { periodStart: '2026-05-01', periodEnd: '2026-05-31' };
  const items = computeBudgetProgress(
    [{ id: 3, category: 'Coffee', currency: 'CAD', amount: '50.0000' }],
    new Map([
      ['CAD\0Coffee', { currency: 'CAD', category: 'Coffee', spent: 75 }],
    ]),
    bounds
  );
  assert.equal(items[0].spent, 75);
  assert.equal(items[0].remaining, -25);
  assert.equal(items[0].percentUsed, 150);
});

test('computeBudgetProgress: budget with no matching spend yields zero spent', () => {
  const bounds = { periodStart: '2026-05-01', periodEnd: '2026-05-31' };
  const items = computeBudgetProgress(
    [{ id: 4, category: 'Pets', currency: 'CAD', amount: '50.0000' }],
    new Map(),
    bounds
  );
  assert.equal(items[0].spent, 0);
  assert.equal(items[0].remaining, 50);
  assert.equal(items[0].percentUsed, 0);
});

// ---- currentMonthBounds ------------------------------------------------

test('currentMonthBounds: returns ISO YYYY-MM-DD bounds for the calendar month', () => {
  const bounds = currentMonthBounds(new Date(2026, 4, 17));
  assert.equal(bounds.periodStart, '2026-05-01');
  assert.equal(bounds.periodEnd, '2026-05-31');
});

test('currentMonthBounds: leap year February ends on the 29th', () => {
  const bounds = currentMonthBounds(new Date(2024, 1, 10));
  assert.equal(bounds.periodStart, '2024-02-01');
  assert.equal(bounds.periodEnd, '2024-02-29');
});

test('currentMonthBounds: short month (April) ends on the 30th', () => {
  const bounds = currentMonthBounds(new Date(2026, 3, 12));
  assert.equal(bounds.periodStart, '2026-04-01');
  assert.equal(bounds.periodEnd, '2026-04-30');
});

// ---- currentPeriodBounds (multi-period support) -----------------------

test('currentPeriodBounds: monthly returns calendar month', () => {
  const bounds = currentPeriodBounds('monthly', new Date(2026, 4, 17));
  assert.equal(bounds.periodStart, '2026-05-01');
  assert.equal(bounds.periodEnd, '2026-05-31');
});

test('currentPeriodBounds: weekly starts on Monday, ends on Sunday', () => {
  // 2026-05-20 is a Wednesday → Monday is 2026-05-18, Sunday is 2026-05-24.
  const bounds = currentPeriodBounds('weekly', new Date(2026, 4, 20));
  assert.equal(bounds.periodStart, '2026-05-18');
  assert.equal(bounds.periodEnd, '2026-05-24');
});

test('currentPeriodBounds: weekly on a Sunday returns that same week', () => {
  // 2026-05-24 is a Sunday — should be the LAST day of its week
  // (Mon 18 - Sun 24), not the start of the next week.
  const bounds = currentPeriodBounds('weekly', new Date(2026, 4, 24));
  assert.equal(bounds.periodStart, '2026-05-18');
  assert.equal(bounds.periodEnd, '2026-05-24');
});

test('currentPeriodBounds: weekly on a Monday returns Mon through Sun', () => {
  // 2026-05-18 is a Monday — first day of its week.
  const bounds = currentPeriodBounds('weekly', new Date(2026, 4, 18));
  assert.equal(bounds.periodStart, '2026-05-18');
  assert.equal(bounds.periodEnd, '2026-05-24');
});

test('currentPeriodBounds: annual returns calendar year', () => {
  const bounds = currentPeriodBounds('annual', new Date(2026, 4, 17));
  assert.equal(bounds.periodStart, '2026-01-01');
  assert.equal(bounds.periodEnd, '2026-12-31');
});

// ---- periodElapsedPercent (the pacing math) ---------------------------

test('periodElapsedPercent: at start of period is 0%', () => {
  const bounds = { periodStart: '2026-05-01', periodEnd: '2026-05-31' };
  const pct = periodElapsedPercent(new Date(2026, 4, 1, 0, 0, 0), bounds);
  assert.equal(Math.round(pct * 100) / 100, 0);
});

test('periodElapsedPercent: at end of period is 100%', () => {
  const bounds = { periodStart: '2026-05-01', periodEnd: '2026-05-31' };
  const pct = periodElapsedPercent(new Date(2026, 4, 31, 23, 59, 59), bounds);
  assert.ok(pct >= 99.99 && pct <= 100, `Expected ~100, got ${pct}`);
});

test('periodElapsedPercent: midway through the period is ~50%', () => {
  // 31-day month: halfway through is end of day 15 / start of day 16 →
  // (15 + 0.5) / 31 * 100 ≈ 50%. We use noon of day 16 for a clean 50%.
  const bounds = { periodStart: '2026-05-01', periodEnd: '2026-05-31' };
  // Day 16 at noon ≈ 50% through a 31-day window (Apr 30 ~midnight → May 31 ~midnight).
  const pct = periodElapsedPercent(new Date(2026, 4, 16, 12, 0, 0), bounds);
  assert.ok(pct > 45 && pct < 55, `Expected ~50, got ${pct}`);
});

test('periodElapsedPercent: before period starts is 0%', () => {
  const bounds = { periodStart: '2026-05-01', periodEnd: '2026-05-31' };
  const pct = periodElapsedPercent(new Date(2026, 3, 30), bounds);
  assert.equal(pct, 0);
});

test('periodElapsedPercent: after period ends is 100%', () => {
  const bounds = { periodStart: '2026-05-01', periodEnd: '2026-05-31' };
  const pct = periodElapsedPercent(new Date(2026, 5, 5), bounds);
  assert.equal(pct, 100);
});

// ---- pacingState (the headline UX) ------------------------------------

test('pacingState: overspent (>100%) is over regardless of pacing', () => {
  assert.equal(pacingState(105, 50), 'over');
  assert.equal(pacingState(120, 95), 'over');
});

test('pacingState: percentUsed within 5pp of elapsed is on-pace', () => {
  // 88% spent vs 90% elapsed → on-pace (delta -2)
  assert.equal(pacingState(88, 90), 'on-pace');
  // 65% spent vs 62% elapsed → on-pace (delta +3)
  assert.equal(pacingState(65, 62), 'on-pace');
  // Exact match
  assert.equal(pacingState(50, 50), 'on-pace');
});

test('pacingState: spending faster than time is ahead (red flag)', () => {
  // The headline example: 88% spent, 62% of month elapsed → ahead.
  assert.equal(pacingState(88, 62), 'ahead');
  assert.equal(pacingState(70, 30), 'ahead');
});

test('pacingState: spending slower than time is behind (frugal)', () => {
  // 30% spent, 80% of month elapsed → behind (under-pacing, on track to save)
  assert.equal(pacingState(30, 80), 'behind');
});

test('pacingState: never returns over for percentUsed exactly 100', () => {
  // 100% spent, 100% elapsed → maxed out but on-pace exactly.
  assert.equal(pacingState(100, 100), 'on-pace');
});
