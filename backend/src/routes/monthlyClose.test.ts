/**
 * Unit tests for the monthly close (issue #227) pure logic. These run in
 * the default `yarn workspace cashflow-backend run test` suite (SQLite),
 * not in `test:integration`, so DATABASE_URL stays unset.
 *
 * Covers:
 * - `isValidPeriodMonth` validator: format + bounds.
 * - `monthRange`: produces correct [start, endExclusive) for normal and
 *   year-rollover (December → next-year January).
 * - `DEFAULT_MONTHLY_CLOSE_TASKS`: stable order, unique keys, each known
 *   task key appears exactly once, critical flag agrees with the spec.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidPeriodMonth } from './monthlyClose';
import { monthRange } from '../cashflow/monthlyCloseCritical';
import {
  DEFAULT_MONTHLY_CLOSE_TASKS,
  MONTHLY_CLOSE_TASK_KEYS,
} from '../models/MonthlyCloseTask';

// ---- isValidPeriodMonth -------------------------------------------------

test('isValidPeriodMonth: accepts well-formed YYYY-MM strings', () => {
  assert.equal(isValidPeriodMonth('2026-01'), true);
  assert.equal(isValidPeriodMonth('2026-12'), true);
  assert.equal(isValidPeriodMonth('1999-05'), true);
});

test('isValidPeriodMonth: rejects non-strings, blanks, and wrong shape', () => {
  assert.equal(isValidPeriodMonth(null), false);
  assert.equal(isValidPeriodMonth(undefined), false);
  assert.equal(isValidPeriodMonth(''), false);
  assert.equal(isValidPeriodMonth('2026'), false);
  assert.equal(isValidPeriodMonth('2026-1'), false);
  assert.equal(isValidPeriodMonth('2026/01'), false);
  assert.equal(isValidPeriodMonth('26-01'), false);
  assert.equal(isValidPeriodMonth(202601), false);
});

test('isValidPeriodMonth: rejects out-of-range months and years', () => {
  assert.equal(isValidPeriodMonth('2026-00'), false);
  assert.equal(isValidPeriodMonth('2026-13'), false);
  assert.equal(isValidPeriodMonth('1899-12'), false);
  assert.equal(isValidPeriodMonth('10000-01'), false);
});

// ---- monthRange ---------------------------------------------------------

test('monthRange: builds [start, endExclusive) for mid-year months', () => {
  assert.deepEqual(monthRange('2026-05'), {
    start: '2026-05-01',
    endExclusive: '2026-06-01',
  });
  assert.deepEqual(monthRange('2026-02'), {
    start: '2026-02-01',
    endExclusive: '2026-03-01',
  });
});

test('monthRange: rolls year over correctly on December', () => {
  assert.deepEqual(monthRange('2026-12'), {
    start: '2026-12-01',
    endExclusive: '2027-01-01',
  });
});

test('monthRange: returns null for malformed input', () => {
  assert.equal(monthRange('2026-13'), null);
  assert.equal(monthRange('not-a-date'), null);
  assert.equal(monthRange(''), null);
});

// ---- DEFAULT_MONTHLY_CLOSE_TASKS ---------------------------------------

test('DEFAULT_MONTHLY_CLOSE_TASKS: sortOrder is strictly increasing', () => {
  for (let i = 1; i < DEFAULT_MONTHLY_CLOSE_TASKS.length; i++) {
    assert.ok(
      DEFAULT_MONTHLY_CLOSE_TASKS[i].sortOrder >
        DEFAULT_MONTHLY_CLOSE_TASKS[i - 1].sortOrder,
      `sortOrder must increase: index ${i - 1}→${i}`,
    );
  }
});

test('DEFAULT_MONTHLY_CLOSE_TASKS: keys are unique and known', () => {
  const seen = new Set<string>();
  for (const spec of DEFAULT_MONTHLY_CLOSE_TASKS) {
    assert.ok(
      (MONTHLY_CLOSE_TASK_KEYS as readonly string[]).includes(spec.taskKey),
      `unknown taskKey ${spec.taskKey}`,
    );
    assert.ok(!seen.has(spec.taskKey), `duplicate taskKey ${spec.taskKey}`);
    seen.add(spec.taskKey);
  }
  assert.equal(seen.size, MONTHLY_CLOSE_TASK_KEYS.length);
});

test('DEFAULT_MONTHLY_CLOSE_TASKS: at least review_inbox and settlements are critical', () => {
  const critical = DEFAULT_MONTHLY_CLOSE_TASKS.filter((t) => t.critical).map(
    (t) => t.taskKey,
  );
  assert.ok(critical.includes('review_inbox'), 'review_inbox must be critical');
  assert.ok(critical.includes('settlements'), 'settlements must be critical');
});

test('DEFAULT_MONTHLY_CLOSE_TASKS: every task has a non-empty title and description', () => {
  for (const spec of DEFAULT_MONTHLY_CLOSE_TASKS) {
    assert.ok(spec.title.length > 0, `empty title for ${spec.taskKey}`);
    assert.ok(
      spec.description.length > 0,
      `empty description for ${spec.taskKey}`,
    );
  }
});
