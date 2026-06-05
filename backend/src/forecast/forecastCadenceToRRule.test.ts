/**
 * Subscription-kind expectations store a `cadence` (weekly|monthly|quarterly|
 * semiannual|annual) and a null recurrenceRule. The forecast must turn that
 * cadence into a recurrence rule so the row projects forward across the window
 * (its seed date is often in the past). These tests pin the cadence→RRULE
 * mapping and one end-to-end roll-forward.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cadenceToRecurrenceRule,
  expandRecurrence,
  type PlannedEventLike,
} from './expandRecurrence';

test('cadenceToRecurrenceRule maps each cadence to a parseable rule', () => {
  assert.equal(cadenceToRecurrenceRule('weekly'), 'FREQ=WEEKLY');
  assert.equal(cadenceToRecurrenceRule('monthly'), 'FREQ=MONTHLY');
  assert.equal(cadenceToRecurrenceRule('quarterly'), 'FREQ=MONTHLY;INTERVAL=3');
  assert.equal(cadenceToRecurrenceRule('semiannual'), 'FREQ=MONTHLY;INTERVAL=6');
  assert.equal(cadenceToRecurrenceRule('annual'), 'FREQ=YEARLY');
});

test('cadenceToRecurrenceRule returns null for unknown/empty cadence', () => {
  assert.equal(cadenceToRecurrenceRule(null), null);
  assert.equal(cadenceToRecurrenceRule(''), null);
  assert.equal(cadenceToRecurrenceRule('fortnightly'), null);
});

test('a monthly subscription with a past seed rolls forward into the window', () => {
  // Mirrors Connor's "Costco Wholesale" sub: seed in the past, monthly cadence.
  const rule = cadenceToRecurrenceRule('monthly');
  assert.ok(rule);
  const event: PlannedEventLike = {
    id: 16,
    expectedDate: '2026-03-02',
    recurrenceRule: rule,
    status: 'planned',
  };
  const occs = expandRecurrence(event, '2026-06-01', '2026-08-31');
  assert.deepEqual(
    occs.map((o) => o.date),
    ['2026-06-02', '2026-07-02', '2026-08-02'],
  );
});
