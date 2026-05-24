import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dayMonthToIso,
  inferYearForMonthDay,
  monthDayToIso,
  parseLongDate,
  parseMoney,
  parsePeriod,
  toIso,
} from '../src/import/pdf/dateHelpers';

test('parseLongDate parses full month + day + 4-digit year', () => {
  assert.equal(parseLongDate('November 3, 2025'), '2025-11-03');
  assert.equal(parseLongDate('Dec 31 2025'), null); // requires "December", not abbreviated
  assert.equal(parseLongDate('garbage'), null);
});

test('parsePeriod parses both-explicit-years form', () => {
  assert.deepEqual(
    parsePeriod('December 13, 2025 to January 12, 2026'),
    { start: '2025-12-13', end: '2026-01-12' },
  );
});

test('parsePeriod parses abbreviated (no-year-on-start) form', () => {
  assert.deepEqual(
    parsePeriod('November 13 to December 12, 2025'),
    { start: '2025-11-13', end: '2025-12-12' },
  );
});

test('parsePeriod handles year boundary in abbreviated form', () => {
  assert.deepEqual(
    parsePeriod('December 13 to January 12, 2026'),
    { start: '2025-12-13', end: '2026-01-12' },
  );
});

test('inferYearForMonthDay maps Nov 4 within a Nov-Dec 2025 period', () => {
  const year = inferYearForMonthDay('Nov 4', { start: '2025-11-03', end: '2025-12-02' });
  assert.equal(year, 2025);
});

test('inferYearForMonthDay throws when date does not fit period', () => {
  assert.throws(() => inferYearForMonthDay('Jul 4', { start: '2025-11-03', end: '2025-12-02' }));
});

test('monthDayToIso converts "Mon DD" to ISO using the period', () => {
  assert.equal(
    monthDayToIso('Nov 4', { start: '2025-11-03', end: '2025-12-02' }),
    '2025-11-04',
  );
});

test('dayMonthToIso accepts RBC personal-banking day-month format', () => {
  assert.equal(
    dayMonthToIso('4 Nov', { start: '2025-11-03', end: '2025-12-02' }),
    '2025-11-04',
  );
  assert.equal(
    dayMonthToIso('1 Dec', { start: '2025-11-03', end: '2025-12-02' }),
    '2025-12-01',
  );
});

test('dayMonthToIso throws on bad input', () => {
  assert.throws(() => dayMonthToIso('garbage', { start: '2025-11-03', end: '2025-12-02' }));
});

test('toIso pads single-digit month + day', () => {
  assert.equal(toIso(2026, 0, 5), '2026-01-05');
  assert.equal(toIso(2026, 11, 31), '2026-12-31');
});

test('parseMoney handles plain, parenthesized, CR-suffixed strings', () => {
  assert.equal(parseMoney('1,234.56'), 1234.56);
  assert.equal(parseMoney('$1,234.56'), 1234.56);
  assert.equal(parseMoney('(1,234.56)'), -1234.56);
  assert.equal(parseMoney('1,234.56 CR'), -1234.56);
  assert.equal(parseMoney('-99.00'), -99.00);
  assert.ok(Number.isNaN(parseMoney('')));
});
