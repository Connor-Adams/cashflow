/**
 * Unit tests for the in-house recurrence expander used by the calendar
 * route. Supports the common RFC 5545 RRULE shapes that show up in
 * personal-finance recurring events:
 *
 *   FREQ=DAILY|WEEKLY|MONTHLY|YEARLY
 *   INTERVAL=N (default 1)
 *   COUNT=N (max occurrences from anchor)
 *   UNTIL=YYYYMMDD or YYYYMMDDTHHMMSSZ (UTC)
 *   BYMONTHDAY=N (1..31, negative not supported)
 *   BYDAY=MO,TU,WE,TH,FR,SA,SU (one or more, weekly only)
 *
 * NOT supported (out of scope for #200 calendar): BYSETPOS, BYMONTH for
 * weekly, BYWEEKNO, BYYEARDAY, EXDATE/RDATE, multiple BYxxx interactions
 * beyond BYDAY in WEEKLY. The forecast worker (#198) may extend this
 * later via its own helper — both are intentionally siloed.
 *
 * If `rule` is null/empty/whitespace, expander returns [anchorDate] if
 * anchorDate is in window, else [].
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandRecurrence } from './expandRecurrence';

test('expandRecurrence: null rule returns the anchor when inside window', () => {
  const out = expandRecurrence(null, '2026-06-15', '2026-06-01', '2026-06-30');
  assert.deepEqual(out, ['2026-06-15']);
});

test('expandRecurrence: null rule returns [] when anchor outside window', () => {
  const out = expandRecurrence(null, '2026-05-15', '2026-06-01', '2026-06-30');
  assert.deepEqual(out, []);
});

test('expandRecurrence: empty rule string treated as one-off', () => {
  assert.deepEqual(
    expandRecurrence('   ', '2026-06-15', '2026-06-01', '2026-06-30'),
    ['2026-06-15'],
  );
});

test('expandRecurrence: FREQ=DAILY expands to every day in window', () => {
  const out = expandRecurrence(
    'FREQ=DAILY',
    '2026-06-01',
    '2026-06-01',
    '2026-06-07',
  );
  assert.deepEqual(out, [
    '2026-06-01',
    '2026-06-02',
    '2026-06-03',
    '2026-06-04',
    '2026-06-05',
    '2026-06-06',
    '2026-06-07',
  ]);
});

test('expandRecurrence: FREQ=DAILY;INTERVAL=2 returns every other day', () => {
  const out = expandRecurrence(
    'FREQ=DAILY;INTERVAL=2',
    '2026-06-01',
    '2026-06-01',
    '2026-06-07',
  );
  assert.deepEqual(out, ['2026-06-01', '2026-06-03', '2026-06-05', '2026-06-07']);
});

test('expandRecurrence: FREQ=WEEKLY follows the anchor weekday', () => {
  // 2026-06-01 is a Monday.
  const out = expandRecurrence(
    'FREQ=WEEKLY',
    '2026-06-01',
    '2026-06-01',
    '2026-06-30',
  );
  assert.deepEqual(out, ['2026-06-01', '2026-06-08', '2026-06-15', '2026-06-22', '2026-06-29']);
});

test('expandRecurrence: FREQ=WEEKLY;BYDAY=MO,WE,FR enumerates 3 days per week', () => {
  // Window is one full week starting Sunday 2026-06-07 to Sat 2026-06-13.
  const out = expandRecurrence(
    'FREQ=WEEKLY;BYDAY=MO,WE,FR',
    '2026-06-01',
    '2026-06-07',
    '2026-06-13',
  );
  // 2026-06-08 Mon, 2026-06-10 Wed, 2026-06-12 Fri
  assert.deepEqual(out, ['2026-06-08', '2026-06-10', '2026-06-12']);
});

test('expandRecurrence: FREQ=MONTHLY rolls forward from anchor day', () => {
  const out = expandRecurrence(
    'FREQ=MONTHLY',
    '2026-06-15',
    '2026-06-01',
    '2026-09-30',
  );
  assert.deepEqual(out, ['2026-06-15', '2026-07-15', '2026-08-15', '2026-09-15']);
});

test('expandRecurrence: FREQ=MONTHLY;BYMONTHDAY=1 anchors regardless of anchor day', () => {
  const out = expandRecurrence(
    'FREQ=MONTHLY;BYMONTHDAY=1',
    '2026-06-15',
    '2026-06-01',
    '2026-09-30',
  );
  // Anchor 6-15 jumps to first of next month, then BYMONTHDAY repeats on the 1st.
  assert.deepEqual(out, ['2026-07-01', '2026-08-01', '2026-09-01']);
});

test('expandRecurrence: FREQ=MONTHLY clamps to month length (no Feb 30)', () => {
  const out = expandRecurrence(
    'FREQ=MONTHLY',
    '2026-01-31',
    '2026-01-01',
    '2026-04-30',
  );
  // Feb has no 31st — RFC 5545 default skips invalid dates. Use Feb 28 as
  // a sensible UX fallback (NOT spec-compliant skip; bills are billed on
  // the last available day in personal finance).
  assert.deepEqual(out, ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
});

test('expandRecurrence: FREQ=YEARLY repeats annually', () => {
  const out = expandRecurrence(
    'FREQ=YEARLY',
    '2026-04-15',
    '2026-01-01',
    '2029-12-31',
  );
  assert.deepEqual(out, ['2026-04-15', '2027-04-15', '2028-04-15', '2029-04-15']);
});

test('expandRecurrence: COUNT caps the number of occurrences from the anchor', () => {
  const out = expandRecurrence(
    'FREQ=MONTHLY;COUNT=3',
    '2026-06-01',
    '2026-06-01',
    '2026-12-31',
  );
  assert.deepEqual(out, ['2026-06-01', '2026-07-01', '2026-08-01']);
});

test('expandRecurrence: UNTIL stops the series at the given date (inclusive)', () => {
  const out = expandRecurrence(
    'FREQ=MONTHLY;UNTIL=20260901',
    '2026-06-01',
    '2026-06-01',
    '2026-12-31',
  );
  assert.deepEqual(out, ['2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01']);
});

test('expandRecurrence: UNTIL with full timestamp format', () => {
  const out = expandRecurrence(
    'FREQ=MONTHLY;UNTIL=20260801T235959Z',
    '2026-06-01',
    '2026-06-01',
    '2026-12-31',
  );
  assert.deepEqual(out, ['2026-06-01', '2026-07-01', '2026-08-01']);
});

test('expandRecurrence: occurrences before windowStart are filtered out', () => {
  const out = expandRecurrence(
    'FREQ=MONTHLY',
    '2026-01-15',
    '2026-06-01',
    '2026-08-31',
  );
  assert.deepEqual(out, ['2026-06-15', '2026-07-15', '2026-08-15']);
});

test('expandRecurrence: occurrences after windowEnd are filtered out', () => {
  const out = expandRecurrence(
    'FREQ=DAILY',
    '2026-06-01',
    '2026-06-01',
    '2026-06-03',
  );
  assert.deepEqual(out, ['2026-06-01', '2026-06-02', '2026-06-03']);
});

test('expandRecurrence: unknown FREQ falls back to one-off (anchor only)', () => {
  const out = expandRecurrence(
    'FREQ=HOURLY',
    '2026-06-01',
    '2026-06-01',
    '2026-06-30',
  );
  assert.deepEqual(out, ['2026-06-01']);
});

test('expandRecurrence: very large window is bounded (no runaway)', () => {
  // Defense-in-depth: 100-year window with FREQ=DAILY should NOT generate
  // 36500 items; the expander caps at MAX_OCCURRENCES.
  const out = expandRecurrence(
    'FREQ=DAILY',
    '2026-01-01',
    '2026-01-01',
    '2126-01-01',
  );
  assert.ok(
    out.length <= 1000,
    `expander must cap occurrences; got ${out.length}`,
  );
});

test('expandRecurrence: malformed rule returns anchor-only', () => {
  const out = expandRecurrence(
    'this is not a rule',
    '2026-06-01',
    '2026-06-01',
    '2026-06-30',
  );
  assert.deepEqual(out, ['2026-06-01']);
});

test('expandRecurrence: windowStart > windowEnd returns empty', () => {
  const out = expandRecurrence('FREQ=DAILY', '2026-06-01', '2026-12-01', '2026-01-01');
  assert.deepEqual(out, []);
});
