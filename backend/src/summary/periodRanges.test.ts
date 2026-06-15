// backend/src/summary/periodRanges.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectRangeKind } from './periodRanges';

test('detectRangeKind identifies a full calendar month', () => {
  assert.equal(detectRangeKind('2026-05-01', '2026-05-31'), 'calendar-month');
  assert.equal(detectRangeKind('2026-02-01', '2026-02-28'), 'calendar-month'); // non-leap Feb
});

test('detectRangeKind identifies a full calendar quarter', () => {
  assert.equal(detectRangeKind('2026-04-01', '2026-06-30'), 'calendar-quarter');
});

test('detectRangeKind identifies a full calendar year', () => {
  assert.equal(detectRangeKind('2026-01-01', '2026-12-31'), 'calendar-year');
});

test('detectRangeKind falls back to custom for partial ranges', () => {
  assert.equal(detectRangeKind('2026-05-03', '2026-05-31'), 'custom');
  assert.equal(detectRangeKind('2026-05-01', '2026-06-15'), 'custom');
});
