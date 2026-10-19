import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coveredMonths, perMonth, DAYS_PER_MONTH } from './dataCoverage';

test('coveredMonths: data spanning the whole window covers the whole window', () => {
  // 2026-01-01..2026-03-31 inclusive = 90 days.
  const m = coveredMonths('2026-01-01', { first: '2025-06-01', latest: '2026-03-31' });
  assert.equal(m, 90 / DAYS_PER_MONTH);
});

test('coveredMonths: a stale import ends the span at the latest transaction', () => {
  // Window opens 2026-01-01 but nothing is imported after 2026-01-31 → 31 days.
  const m = coveredMonths('2026-01-01', { first: '2025-06-01', latest: '2026-01-31' });
  assert.equal(m, 31 / DAYS_PER_MONTH);
});

test('coveredMonths: a household whose data starts mid-window starts at its first transaction', () => {
  const m = coveredMonths('2026-01-01', { first: '2026-03-02', latest: '2026-03-31' });
  assert.equal(m, 30 / DAYS_PER_MONTH);
});

test('coveredMonths: a single day of data is one day', () => {
  const m = coveredMonths('2026-01-01', { first: '2026-02-10', latest: '2026-02-10' });
  assert.equal(m, 1 / DAYS_PER_MONTH);
});

test('coveredMonths: no transactions → null', () => {
  assert.equal(coveredMonths('2026-01-01', { first: null, latest: null }), null);
});

test('coveredMonths: latest transaction before the window opens → null', () => {
  assert.equal(coveredMonths('2026-01-01', { first: '2025-01-01', latest: '2025-12-31' }), null);
});

test('perMonth: normalizes a total over the covered months, rounded to cents', () => {
  assert.equal(perMonth(3100, 31 / DAYS_PER_MONTH), 3044);
  assert.equal(perMonth(100, 3), 33.33);
});

test('perMonth: no coverage → null', () => {
  assert.equal(perMonth(500, null), null);
});
