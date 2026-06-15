// backend/src/summary/periodRanges.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectRangeKind } from './periodRanges';
import { priorPeriod, samePeriodLastYear } from './periodRanges';

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

test('priorPeriod returns the previous calendar month', () => {
  assert.deepEqual(priorPeriod('2026-05-01', '2026-05-31', 'calendar-month'), {
    from: '2026-04-01',
    to: '2026-04-30',
  });
  assert.deepEqual(priorPeriod('2026-01-01', '2026-01-31', 'calendar-month'), {
    from: '2025-12-01',
    to: '2025-12-31',
  });
});

test('priorPeriod returns previous quarter and year', () => {
  assert.deepEqual(priorPeriod('2026-04-01', '2026-06-30', 'calendar-quarter'), {
    from: '2026-01-01',
    to: '2026-03-31',
  });
  assert.deepEqual(priorPeriod('2026-01-01', '2026-12-31', 'calendar-year'), {
    from: '2025-01-01',
    to: '2025-12-31',
  });
});

test('priorPeriod for custom returns the prior equal-length span ending the day before', () => {
  // 2026-05-10..2026-05-19 is 10 days; prior span is 2026-04-30..2026-05-09
  assert.deepEqual(priorPeriod('2026-05-10', '2026-05-19', 'custom'), {
    from: '2026-04-30',
    to: '2026-05-09',
  });
});

test('samePeriodLastYear shifts calendar periods back one year, clamping Feb', () => {
  assert.deepEqual(samePeriodLastYear('2026-06-01', '2026-06-30', 'calendar-month'), {
    from: '2025-06-01',
    to: '2025-06-30',
  });
  // leap-day clamp: 2024-02-29 -> 2023-02-28
  assert.deepEqual(samePeriodLastYear('2024-02-01', '2024-02-29', 'calendar-month'), {
    from: '2023-02-01',
    to: '2023-02-28',
  });
  assert.equal(samePeriodLastYear('2026-05-10', '2026-05-19', 'custom'), null);
});
