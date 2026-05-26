/**
 * Notification system — server helper (issue #266).
 *
 * Single entry point that downstream features (budget breach, weekly digest,
 * AI insights, subscription price changes, etc.) call when they want to
 * surface something to a user. This issue intentionally implements the
 * in-app channel only — email is the next issue's job.
 *
 * Contract:
 *   1. Look up the user's preference for the given `type`.
 *   2. If no preference row exists, fall back to the bundled defaults
 *      (`channelInApp=true`, `channelEmail=false`). This means a brand-new
 *      notification type is delivered in-app the first time it fires,
 *      *without* a backfill migration — the Settings UI lazily lists the
 *      type once it appears in either the preference table or the
 *      notifications table.
 *   3. If `channelInApp` is true, write a row into `notifications`.
 *      Otherwise skip the write entirely (the user has muted this type).
 *   4. Never send email. Email channel is wired in the downstream issues
 *      that depend on this one — invoking those queues is NOT this helper's
 *      job; otherwise we'd accidentally couple every event-source feature
 *      to a mailer.
 *   5. The helper validates the payload shape and rejects oversized fields
 *      so a misbehaving caller can't insert an invalid row that the route
 *      layer would later refuse to deserialize.
 */
import {
  Notification,
  NOTIFICATION_SEVERITIES,
  NOTIFICATION_TITLE_MAX_LENGTH,
  NOTIFICATION_TYPE_MAX_LENGTH,
  type NotificationSeverity,
} from '../models/Notification';
import {
  NotificationPreference,
  NOTIFICATION_PREFERENCE_DEFAULTS,
} from '../models/NotificationPreference';

export type EnqueueNotificationPayload = {
  severity?: NotificationSeverity;
  title: string;
  body: string;
  dataJson?: Record<string, unknown> | null;
};

export type EnqueueNotificationResult =
  | { status: 'created'; notification: Notification }
  | { status: 'muted' };

function validateType(type: string): void {
  if (!type || type.length === 0) {
    throw new Error('enqueueNotification: type is required');
  }
  if (type.length > NOTIFICATION_TYPE_MAX_LENGTH) {
    throw new Error(
      `enqueueNotification: type exceeds ${NOTIFICATION_TYPE_MAX_LENGTH} chars`,
    );
  }
}

function validatePayload(payload: EnqueueNotificationPayload): void {
  if (!payload.title || payload.title.length === 0) {
    throw new Error('enqueueNotification: title is required');
  }
  if (payload.title.length > NOTIFICATION_TITLE_MAX_LENGTH) {
    throw new Error(
      `enqueueNotification: title exceeds ${NOTIFICATION_TITLE_MAX_LENGTH} chars`,
    );
  }
  if (payload.body == null) {
    throw new Error('enqueueNotification: body is required');
  }
  if (
    payload.severity !== undefined &&
    !NOTIFICATION_SEVERITIES.includes(payload.severity)
  ) {
    throw new Error(
      `enqueueNotification: severity must be one of ${NOTIFICATION_SEVERITIES.join(', ')}`,
    );
  }
}

/**
 * Resolve the (channelInApp, channelEmail) preference for a given (user,
 * type) tuple. Returns the explicit row if it exists, otherwise the
 * defaults. Exported so the routes layer can reuse it when building the
 * `/api/notification-preferences` list response (AC #8).
 */
export async function resolveNotificationPreference(
  userId: number,
  type: string,
): Promise<{ channelInApp: boolean; channelEmail: boolean }> {
  const row = await NotificationPreference.findOne({
    where: { userId, type },
  });
  if (row) {
    return {
      channelInApp: row.channelInApp,
      channelEmail: row.channelEmail,
    };
  }
  return {
    channelInApp: NOTIFICATION_PREFERENCE_DEFAULTS.channelInApp,
    channelEmail: NOTIFICATION_PREFERENCE_DEFAULTS.channelEmail,
  };
}

/**
 * Enqueue a notification for a user. Writes the in-app row when the user's
 * preference for `type` allows it; otherwise no-ops.
 *
 * Does NOT touch any email queue / mailer — that's the responsibility of
 * the channel-specific follow-up issue. Until that lands, `channelEmail`
 * is recorded purely for UI / preference-table purposes.
 */
export async function enqueueNotification(
  userId: number,
  type: string,
  payload: EnqueueNotificationPayload,
): Promise<EnqueueNotificationResult> {
  validateType(type);
  validatePayload(payload);

  const pref = await resolveNotificationPreference(userId, type);
  if (!pref.channelInApp) {
    return { status: 'muted' };
  }

  const notification = await Notification.create({
    userId,
    type,
    severity: payload.severity ?? 'info',
    title: payload.title,
    body: payload.body,
    dataJson: payload.dataJson ?? null,
  });

  return { status: 'created', notification };
}
