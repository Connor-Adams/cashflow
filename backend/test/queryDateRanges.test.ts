/**
 * Pure unit tests for the date-range preset resolver. The resolver translates
 * AI-emitted preset strings (`this_month`, `last_quarter`, …) into the date
 * windows the query builders feed to Sequelize. Tests pin `today` so the
 * suite is calendar-deterministic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDateRange } from '../src/ai/queryDateRanges.js';

test('this_month returns the calendar month containing today', () => {
  const r = resolveDateRange('this_month', new Date(2026, 4, 15));
  assert.deepEqual(r, { from: '2026-05-01', to: '2026-05-31', label: 'this month' });
});

test('last_month returns the previous calendar month', () => {
  const r = resolveDateRange('last_month', new Date(2026, 4, 15));
  assert.deepEqual(r, { from: '2026-04-01', to: '2026-04-30', label: 'last month' });
});

test('last_month rolls over the new year correctly', () => {
  const r = resolveDateRange('last_month', new Date(2026, 0, 5));
  assert.deepEqual(r, { from: '2025-12-01', to: '2025-12-31', label: 'last month' });
});

test('this_quarter handles Q2 mid-quarter date', () => {
  const r = resolveDateRange('this_quarter', new Date(2026, 4, 15));
  assert.deepEqual(r, { from: '2026-04-01', to: '2026-06-30', label: 'this quarter' });
});

test('last_quarter handles Q1 by returning Q4 of prior year', () => {
  const r = resolveDateRange('last_quarter', new Date(2026, 1, 15));
  assert.deepEqual(r, { from: '2025-10-01', to: '2025-12-31', label: 'last quarter' });
});

test('this_year returns the calendar year', () => {
  const r = resolveDateRange('this_year', new Date(2026, 4, 15));
  assert.deepEqual(r, { from: '2026-01-01', to: '2026-12-31', label: 'this year' });
});

test('all_time returns the unbounded marker', () => {
  const r = resolveDateRange('all_time');
  assert.deepEqual(r, { all: true, label: 'all time' });
});

test('this_week starts on Monday and ends on Sunday', () => {
  // 2026-05-15 is a Friday.
  const r = resolveDateRange('this_week', new Date(2026, 4, 15));
  if ('all' in r) {
    throw new Error('expected bounded range');
  }
  assert.equal(r.from, '2026-05-11'); // Monday
  assert.equal(r.to, '2026-05-17'); // Sunday
});
