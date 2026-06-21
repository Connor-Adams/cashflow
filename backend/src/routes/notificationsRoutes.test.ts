/**
 * Pure-function unit tests for the notification routes — these cover the
 * query parsing + validator logic without booting the DB. Integration tests
 * (full HTTP round-trip with a real Postgres) live in
 * `test/integration/notifications.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLimit, parseUnreadOnly } from './notifications';
// After the #379 fold the preference patch validator lives in the single
// notification service module, not the (now-410) standalone prefs route.
import { validateNotificationPreferencePatch } from '../notifications/index';

test('parseLimit: default when missing', () => {
  assert.equal(parseLimit(undefined), 20);
  assert.equal(parseLimit(''), 20);
});

test('parseLimit: clamps to MAX_LIMIT (100)', () => {
  assert.equal(parseLimit('500'), 100);
  assert.equal(parseLimit(99999), 100);
});

test('parseLimit: rejects non-positive', () => {
  assert.equal(parseLimit('0'), 20);
  assert.equal(parseLimit('-5'), 20);
});

test('parseLimit: floors fractional values', () => {
  assert.equal(parseLimit('17.9'), 17);
});

test('parseLimit: defaults on garbage', () => {
  assert.equal(parseLimit('abc'), 20);
  assert.equal(parseLimit(NaN), 20);
});

test('parseUnreadOnly: true forms', () => {
  assert.equal(parseUnreadOnly('true'), true);
  assert.equal(parseUnreadOnly('1'), true);
  assert.equal(parseUnreadOnly(true), true);
});

test('parseUnreadOnly: false forms', () => {
  assert.equal(parseUnreadOnly('false'), false);
  assert.equal(parseUnreadOnly('0'), false);
  assert.equal(parseUnreadOnly(undefined), false);
  assert.equal(parseUnreadOnly(''), false);
  assert.equal(parseUnreadOnly('yes'), false);
});

test('validateNotificationPreferencePatch: empty body is ok with empty patch', () => {
  const r = validateNotificationPreferencePatch({});
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.patch, {});
});

test('validateNotificationPreferencePatch: accepts both flags', () => {
  const r = validateNotificationPreferencePatch({
    channelInApp: false,
    channelEmail: true,
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.patch, { channelInApp: false, channelEmail: true });
});

test('validateNotificationPreferencePatch: rejects non-boolean channelInApp', () => {
  const r = validateNotificationPreferencePatch({ channelInApp: 'true' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /channelInApp must be boolean/);
});

test('validateNotificationPreferencePatch: rejects non-boolean channelEmail', () => {
  const r = validateNotificationPreferencePatch({ channelEmail: 1 });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /channelEmail must be boolean/);
});

test('validateNotificationPreferencePatch: accepts channelPush + digestDayOfWeek (#796)', () => {
  const r = validateNotificationPreferencePatch({
    channelPush: true,
    digestDayOfWeek: 3,
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.patch, { channelPush: true, digestDayOfWeek: 3 });
});

test('validateNotificationPreferencePatch: rejects out-of-range digestDayOfWeek (#796)', () => {
  for (const bad of [7, -1, 1.5, '1' as unknown as number]) {
    const r = validateNotificationPreferencePatch({ digestDayOfWeek: bad });
    assert.equal(r.ok, false, `${String(bad)} should be rejected`);
    if (!r.ok) assert.match(r.error, /digestDayOfWeek must be an integer 0\.\.6/);
  }
});
