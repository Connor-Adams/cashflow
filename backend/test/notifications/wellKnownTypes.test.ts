/**
 * Sanity test: the GET /api/notification-preferences route must surface the
 * curated `digest.weekly` well-known type even before the first digest
 * notification fires (issue #267 AC #12 / Settings opt-in pre-cron).
 *
 * Light-weight unit test — only asserts that the constant is wired and
 * includes the expected value. The full HTTP round-trip is covered by the
 * existing integration test that exercises the same code path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WELL_KNOWN_NOTIFICATION_TYPES } from '../../src/routes/notificationPreferences';

test('WELL_KNOWN_NOTIFICATION_TYPES includes digest.weekly', () => {
  assert.ok(
    WELL_KNOWN_NOTIFICATION_TYPES.includes('digest.weekly'),
    `expected digest.weekly in well-known set, got: ${WELL_KNOWN_NOTIFICATION_TYPES.join(',')}`,
  );
});
