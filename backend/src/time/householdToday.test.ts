import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TIMEZONE,
  todayInZone,
  resolveHouseholdTimezone,
  resolveHouseholdToday,
} from './householdToday';

test('DEFAULT_TIMEZONE is America/Toronto', () => {
  assert.equal(DEFAULT_TIMEZONE, 'America/Toronto');
});

test('todayInZone returns a YYYY-MM-DD string', () => {
  const iso = todayInZone('America/Toronto', new Date('2026-06-14T16:00:00Z'));
  assert.match(iso, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(iso, '2026-06-14');
});

test('an early-UTC instant maps to the previous calendar day in Toronto', () => {
  // 02:00 UTC on Jan 1 is still 21:00 (EST, UTC-5) on Dec 31 in Toronto.
  const now = new Date('2026-01-01T02:00:00Z');
  assert.equal(todayInZone('America/Toronto', now), '2025-12-31');
  // The naive UTC slice would (wrongly) report Jan 1.
  assert.equal(now.toISOString().slice(0, 10), '2026-01-01');
});

test('todayInZone is DST-aware (no manual offset math)', () => {
  // 2026-03-08 is the US/Canada spring-forward day. At 06:30 UTC the clock
  // in Toronto reads 01:30 EST (UTC-5, before the 02:00 jump) — still Mar 8.
  const before = new Date('2026-03-08T06:30:00Z');
  assert.equal(todayInZone('America/Toronto', before), '2026-03-08');
  // 03:30 UTC the same night is 22:30 EST on Mar 7.
  const prevNight = new Date('2026-03-08T03:30:00Z');
  assert.equal(todayInZone('America/Toronto', prevNight), '2026-03-07');
  // After the jump, an early-summer instant at 03:00 UTC on Jul 1 is
  // 23:00 EDT (UTC-4) on Jun 30 — DST shifts the boundary by an hour.
  const summer = new Date('2026-07-01T03:00:00Z');
  assert.equal(todayInZone('America/Toronto', summer), '2026-06-30');
});

test('todayInZone respects other zones', () => {
  // 23:00 UTC on Jun 14 is already Jun 15 in Tokyo (UTC+9).
  const now = new Date('2026-06-14T23:00:00Z');
  assert.equal(todayInZone('Asia/Tokyo', now), '2026-06-15');
  assert.equal(todayInZone('America/Toronto', now), '2026-06-14');
});

test('todayInZone falls back to DEFAULT_TIMEZONE for an unknown zone', () => {
  const now = new Date('2026-01-01T02:00:00Z');
  assert.equal(todayInZone('Not/AZone', now), '2025-12-31');
});

test('resolveHouseholdTimezone uses the household value when present', () => {
  assert.equal(resolveHouseholdTimezone({ timezone: 'Asia/Tokyo' }), 'Asia/Tokyo');
});

test('resolveHouseholdTimezone falls back to DEFAULT for null/blank/undefined', () => {
  assert.equal(resolveHouseholdTimezone({ timezone: null }), DEFAULT_TIMEZONE);
  assert.equal(resolveHouseholdTimezone({ timezone: '' }), DEFAULT_TIMEZONE);
  assert.equal(resolveHouseholdTimezone({ timezone: '   ' }), DEFAULT_TIMEZONE);
  assert.equal(resolveHouseholdTimezone(undefined), DEFAULT_TIMEZONE);
  assert.equal(resolveHouseholdTimezone(null), DEFAULT_TIMEZONE);
});

test('resolveHouseholdToday combines zone resolution with todayInZone', () => {
  const now = new Date('2026-01-01T02:00:00Z');
  // Toronto household: still Dec 31.
  assert.equal(resolveHouseholdToday({ timezone: 'America/Toronto' }, now), '2025-12-31');
  // Tokyo household: already Jan 1.
  assert.equal(resolveHouseholdToday({ timezone: 'Asia/Tokyo' }, now), '2026-01-01');
  // No timezone → DEFAULT (Toronto) → Dec 31.
  assert.equal(resolveHouseholdToday({ timezone: null }, now), '2025-12-31');
});
