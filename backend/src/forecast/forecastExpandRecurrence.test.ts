import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  expandRecurrence,
  type PlannedEventLike,
} from './expandRecurrence';

// ---------------------------------------------------------------------------
// expandRecurrence — turn one PlannedEvent into a list of dated occurrences
// inside [dateFrom, dateTo]. The expander is a pure function: no DB, no time
// concept (callers supply the window). One-off events (no recurrence_rule)
// just emit one occurrence on expectedDate (if in window) or none.
// ---------------------------------------------------------------------------

test('expandRecurrence: one-off event inside window emits one occurrence', () => {
  const event: PlannedEventLike = {
    id: 1,
    expectedDate: '2026-06-15',
    recurrenceRule: null,
    status: 'planned',
  };
  const occs = expandRecurrence(event, '2026-06-01', '2026-06-30');
  assert.equal(occs.length, 1);
  assert.equal(occs[0].date, '2026-06-15');
  assert.equal(occs[0].sourceEventId, 1);
});

test('expandRecurrence: one-off event outside window emits no occurrences', () => {
  const event: PlannedEventLike = {
    id: 1,
    expectedDate: '2026-08-01',
    recurrenceRule: null,
    status: 'planned',
  };
  const occs = expandRecurrence(event, '2026-06-01', '2026-06-30');
  assert.equal(occs.length, 0);
});

test('expandRecurrence: posted event is skipped (already realised)', () => {
  // posted events have a linkedTransactionId and should not be projected
  // again — they would double-count the actual transaction.
  const event: PlannedEventLike = {
    id: 1,
    expectedDate: '2026-06-15',
    recurrenceRule: null,
    status: 'posted',
  };
  const occs = expandRecurrence(event, '2026-06-01', '2026-06-30');
  assert.equal(occs.length, 0);
});

test('expandRecurrence: skipped event is skipped (user dismissed)', () => {
  const event: PlannedEventLike = {
    id: 1,
    expectedDate: '2026-06-15',
    recurrenceRule: null,
    status: 'skipped',
  };
  const occs = expandRecurrence(event, '2026-06-01', '2026-06-30');
  assert.equal(occs.length, 0);
});

test('expandRecurrence: ignored event is skipped', () => {
  const event: PlannedEventLike = {
    id: 1,
    expectedDate: '2026-06-15',
    recurrenceRule: null,
    status: 'ignored',
  };
  const occs = expandRecurrence(event, '2026-06-01', '2026-06-30');
  assert.equal(occs.length, 0);
});

test('expandRecurrence: monthly RRULE expands to one occurrence per month in window', () => {
  // Paycheck on the 15th, starting May 15. Window: June 1 - Aug 31 → 3 occs.
  const event: PlannedEventLike = {
    id: 7,
    expectedDate: '2026-05-15',
    recurrenceRule: 'FREQ=MONTHLY;BYMONTHDAY=15',
    status: 'planned',
  };
  const occs = expandRecurrence(event, '2026-06-01', '2026-08-31');
  assert.deepEqual(
    occs.map((o) => o.date),
    ['2026-06-15', '2026-07-15', '2026-08-15'],
  );
  for (const occ of occs) assert.equal(occ.sourceEventId, 7);
});

test('expandRecurrence: monthly RRULE clamps to last day for short months', () => {
  // BYMONTHDAY=31 — February only has 28/29, April/June/Sept/Nov have 30.
  // The expander clamps to last available day; this is the same behaviour
  // most calendar tools use (vs. skipping entirely).
  const event: PlannedEventLike = {
    id: 1,
    expectedDate: '2026-01-31',
    recurrenceRule: 'FREQ=MONTHLY;BYMONTHDAY=31',
    status: 'planned',
  };
  const occs = expandRecurrence(event, '2026-02-01', '2026-05-01');
  const dates = occs.map((o) => o.date);
  assert.ok(dates.includes('2026-02-28') || dates.includes('2026-02-29'));
  assert.ok(dates.includes('2026-03-31'));
  assert.ok(dates.includes('2026-04-30'));
});

test('expandRecurrence: monthly day-31 anchor recovers after a short month (no BYMONTHDAY)', () => {
  // cadenceToRecurrenceRule emits bare FREQ=MONTHLY for subscriptions, so the
  // anchor day must come from the seed date: Jan 31 → Feb 28 (clamped) must
  // recover to Mar 31, not drift to the 28th forever.
  const event: PlannedEventLike = {
    id: 11,
    expectedDate: '2026-01-31',
    recurrenceRule: 'FREQ=MONTHLY',
    status: 'planned',
  };
  const occs = expandRecurrence(event, '2026-01-01', '2026-04-30');
  assert.deepEqual(
    occs.map((o) => o.date),
    ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30'],
  );
});

test('expandRecurrence: quarterly (INTERVAL=3) day-31 anchor clamps per-month without drifting', () => {
  // Jan 31 quarterly: Apr 30 (clamped), then back to Jul 31 and Oct 31 —
  // not Jul 30 / Oct 30 forever.
  const event: PlannedEventLike = {
    id: 12,
    expectedDate: '2026-01-31',
    recurrenceRule: 'FREQ=MONTHLY;INTERVAL=3',
    status: 'planned',
  };
  const occs = expandRecurrence(event, '2026-01-01', '2026-12-31');
  assert.deepEqual(
    occs.map((o) => o.date),
    ['2026-01-31', '2026-04-30', '2026-07-31', '2026-10-31'],
  );
});

test('expandRecurrence: yearly Feb-29 anchor returns to Feb 29 in leap years', () => {
  const event: PlannedEventLike = {
    id: 13,
    expectedDate: '2024-02-29',
    recurrenceRule: 'FREQ=YEARLY',
    status: 'planned',
  };
  const occs = expandRecurrence(event, '2024-01-01', '2028-12-31');
  assert.deepEqual(
    occs.map((o) => o.date),
    ['2024-02-29', '2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29'],
  );
});

test('expandRecurrence: weekly RRULE expands every 7 days', () => {
  // Coffee subscription, every Friday, starting May 1 (a Fri). Window:
  // May 8 to May 31 → Fri 8/15/22/29.
  const event: PlannedEventLike = {
    id: 2,
    expectedDate: '2026-05-01',
    recurrenceRule: 'FREQ=WEEKLY',
    status: 'planned',
  };
  const occs = expandRecurrence(event, '2026-05-08', '2026-05-31');
  assert.deepEqual(
    occs.map((o) => o.date),
    ['2026-05-08', '2026-05-15', '2026-05-22', '2026-05-29'],
  );
});

test('expandRecurrence: biweekly via INTERVAL=2 expands every 14 days', () => {
  // Biweekly paycheck. expectedDate May 1, window covers two paydays at
  // May 15 and May 29.
  const event: PlannedEventLike = {
    id: 3,
    expectedDate: '2026-05-01',
    recurrenceRule: 'FREQ=WEEKLY;INTERVAL=2',
    status: 'planned',
  };
  const occs = expandRecurrence(event, '2026-05-02', '2026-05-31');
  assert.deepEqual(
    occs.map((o) => o.date),
    ['2026-05-15', '2026-05-29'],
  );
});

test('expandRecurrence: yearly RRULE expands once per year', () => {
  const event: PlannedEventLike = {
    id: 4,
    expectedDate: '2024-04-30',
    recurrenceRule: 'FREQ=YEARLY',
    status: 'planned',
  };
  const occs = expandRecurrence(event, '2026-01-01', '2028-12-31');
  assert.deepEqual(
    occs.map((o) => o.date),
    ['2026-04-30', '2027-04-30', '2028-04-30'],
  );
});

test('expandRecurrence: COUNT=N caps total occurrences', () => {
  const event: PlannedEventLike = {
    id: 5,
    expectedDate: '2026-01-15',
    recurrenceRule: 'FREQ=MONTHLY;COUNT=3',
    status: 'planned',
  };
  // window is large; COUNT=3 should bound output to Jan, Feb, Mar.
  const occs = expandRecurrence(event, '2026-01-01', '2026-12-31');
  assert.deepEqual(
    occs.map((o) => o.date),
    ['2026-01-15', '2026-02-15', '2026-03-15'],
  );
});

test('expandRecurrence: UNTIL=YYYYMMDD caps last occurrence', () => {
  const event: PlannedEventLike = {
    id: 6,
    expectedDate: '2026-01-15',
    recurrenceRule: 'FREQ=MONTHLY;UNTIL=20260315',
    status: 'planned',
  };
  const occs = expandRecurrence(event, '2026-01-01', '2026-12-31');
  // Last in-rule occurrence is March 15 (UNTIL is inclusive).
  assert.deepEqual(
    occs.map((o) => o.date),
    ['2026-01-15', '2026-02-15', '2026-03-15'],
  );
});

test('expandRecurrence: window starts after expectedDate — emits from first in-window occurrence', () => {
  // expectedDate is the seed for monthly cadence; window cuts in mid-stream.
  const event: PlannedEventLike = {
    id: 8,
    expectedDate: '2026-01-15',
    recurrenceRule: 'FREQ=MONTHLY;BYMONTHDAY=15',
    status: 'planned',
  };
  const occs = expandRecurrence(event, '2026-06-01', '2026-09-30');
  assert.deepEqual(
    occs.map((o) => o.date),
    ['2026-06-15', '2026-07-15', '2026-08-15', '2026-09-15'],
  );
});

test('expandRecurrence: invalid RRULE → returns no occurrences (defensive)', () => {
  // We never want to crash because of bad rule strings written by a user.
  const event: PlannedEventLike = {
    id: 9,
    expectedDate: '2026-06-15',
    recurrenceRule: 'this is not an rrule',
    status: 'planned',
  };
  const occs = expandRecurrence(event, '2026-06-01', '2026-06-30');
  // Behaviour: fall back to a single occurrence on expectedDate if it's in
  // the window. Better to forecast based on the stated date than to silently
  // drop a row entirely.
  assert.equal(occs.length, 1);
  assert.equal(occs[0].date, '2026-06-15');
});

test('expandRecurrence: empty window yields nothing', () => {
  const event: PlannedEventLike = {
    id: 10,
    expectedDate: '2026-06-15',
    recurrenceRule: 'FREQ=MONTHLY;BYMONTHDAY=15',
    status: 'planned',
  };
  // dateTo before dateFrom = empty window
  const occs = expandRecurrence(event, '2026-09-01', '2026-08-01');
  assert.equal(occs.length, 0);
});
