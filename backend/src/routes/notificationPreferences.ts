/**
 * Notification preference routes — DEPRECATED (issue #379).
 *
 * All active endpoints have moved to /api/users/me/notifications/preferences.
 * This router now returns 410 Gone for all requests so that existing clients
 * get a clear signal to upgrade.
 *
 * The exported types/constants/validator below are retained because tests
 * import them directly from this module.
 */
import { Router } from 'express';

const router = Router();

export type SerializedNotificationPreference = {
  type: string;
  channelInApp: boolean;
  channelEmail: boolean;
};

/**
 * Notification types that the Settings UI should ALWAYS show, even before
 * the first notification of that type has fired for a user. Lets users
 * opt-in (or opt-out) ahead of time. New entries here must be the same
 * string the `enqueueNotification` call-sites pass as `type`.
 */
export const WELL_KNOWN_NOTIFICATION_TYPES: readonly string[] = [
  'digest.weekly',
];

/** Validator exported for unit testing. */
export function validateNotificationPreferencePatch(
  raw: Record<string, unknown>,
):
  | { ok: true; patch: { channelInApp?: boolean; channelEmail?: boolean } }
  | { ok: false; error: string } {
  const patch: { channelInApp?: boolean; channelEmail?: boolean } = {};

  if (raw.channelInApp !== undefined) {
    if (typeof raw.channelInApp !== 'boolean') {
      return { ok: false, error: 'channelInApp must be boolean' };
    }
    patch.channelInApp = raw.channelInApp;
  }

  if (raw.channelEmail !== undefined) {
    if (typeof raw.channelEmail !== 'boolean') {
      return { ok: false, error: 'channelEmail must be boolean' };
    }
    patch.channelEmail = raw.channelEmail;
  }

  return { ok: true, patch };
}

router.all('*', (_req, res) => {
  res.status(410).json({
    error: 'gone',
    message: 'Use /api/users/me/notifications/preferences',
  });
});

export default router;
