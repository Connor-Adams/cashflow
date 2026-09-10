import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dateFromInternalDate } from './internalDate';

test('converts Gmail internalDate ms-since-epoch to a UTC date string', () => {
  // 2025-08-28T14:32:11Z
  assert.equal(dateFromInternalDate('1756391531000'), '2025-08-28');
});

test('uses UTC, not local time, near a day boundary', () => {
  // 2025-08-28T23:59:59Z — must not roll back a day in a negative-offset TZ
  assert.equal(dateFromInternalDate('1756425599000'), '2025-08-28');
});

test('returns null for null, undefined, empty and non-numeric input', () => {
  assert.equal(dateFromInternalDate(null), null);
  assert.equal(dateFromInternalDate(undefined), null);
  assert.equal(dateFromInternalDate(''), null);
  assert.equal(dateFromInternalDate('not-a-number'), null);
});
