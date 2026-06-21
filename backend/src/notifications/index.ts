/**
 * Notification service — the single module that owns the in-app notification
 * concern (issues #266, #379).
 *
 * Before issue #379 the notification logic was split: this module held
 * dispatch (`enqueueNotification`) plus a public `resolveNotificationPreference`
 * helper, while a separate `routes/notificationPreferences.ts` owned the
 * preference list/patch business logic. The primitives-spine convergence
 * (#379) treats Notification as a delivery *transport* (a Support concern, not
 * a primitive) and collapses that split: this module is now the one place that
 * owns dispatch, preference read, and preference write. The per-(user, type)
 * preference lookup is a PRIVATE helper (`resolvePreference`) invoked only by
 * the dispatch path — it is no longer a public service of its own.
 *
 * Dispatch contract:
 *   1. Look up the user's preference for the given `type` (private lookup).
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
import { fanOutWebPush, type WebPushSender } from './webPush';

export type EnqueueNotificationPayload = {
  severity?: NotificationSeverity;
  title: string;
  body: string;
  dataJson?: Record<string, unknown> | null;
};

export type EnqueueNotificationResult =
  | { status: 'created'; notification: Notification }
  | { status: 'muted' };

/** Wire shape for a single preference row returned by the prefs API. */
export type SerializedNotificationPreference = {
  type: string;
  channelInApp: boolean;
  channelEmail: boolean;
  channelPush: boolean;
  /** 0=Sun … 6=Sat; only meaningful for `digest.weekly` (#796). */
  digestDayOfWeek: number;
};

/** Validated patch shape for a preference upsert. */
export type NotificationPreferencePatch = {
  channelInApp?: boolean;
  channelEmail?: boolean;
  channelPush?: boolean;
  digestDayOfWeek?: number;
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
 * Resolve the (channelInApp, channelEmail, channelPush) preference for a given
 * (user, type) tuple. Returns the explicit row if it exists, otherwise the
 * defaults.
 *
 * PRIVATE (issue #379): this is the dispatch path's preference lookup. It is
 * intentionally NOT exported — there is one notification service and the
 * lookup is an implementation detail of `enqueueNotification`, not a public
 * surface other modules call directly. The list/patch endpoints below are the
 * only public preference operations.
 */
async function resolvePreference(
  userId: number,
  type: string,
): Promise<{ channelInApp: boolean; channelEmail: boolean; channelPush: boolean }> {
  const row = await NotificationPreference.findOne({
    where: { userId, type },
  });
  if (row) {
    return {
      channelInApp: row.channelInApp,
      channelEmail: row.channelEmail,
      channelPush: row.channelPush,
    };
  }
  return {
    channelInApp: NOTIFICATION_PREFERENCE_DEFAULTS.channelInApp,
    channelEmail: NOTIFICATION_PREFERENCE_DEFAULTS.channelEmail,
    channelPush: NOTIFICATION_PREFERENCE_DEFAULTS.channelPush,
  };
}

/**
 * Enqueue a notification for a user. Writes the in-app row when the user's
 * preference for `type` allows it; otherwise no-ops.
 *
 * Web-push (issue #651): after a successful in-app write, if the user's
 * `channelPush` is enabled, fan a web-push out to every active subscription
 * the user owns (see `fanOutWebPush`). This is the single dispatch seam, so
 * every event source (budget breach, future types) gets push for free without
 * coupling each job to the push library. Push delivery is best-effort: a send
 * failure NEVER affects the in-app result. When `channelPush` is false, or the
 * user has no subscriptions, or VAPID is unconfigured, no push is sent and the
 * in-app behavior is unchanged.
 *
 * Does NOT touch any email queue / mailer — that's the responsibility of
 * the channel-specific follow-up issue. Until that lands, `channelEmail`
 * is recorded purely for UI / preference-table purposes.
 *
 * `pushSender` is injectable for tests; production uses the default web-push
 * sender inside `fanOutWebPush`.
 */
export async function enqueueNotification(
  userId: number,
  type: string,
  payload: EnqueueNotificationPayload,
  pushSender?: WebPushSender,
): Promise<EnqueueNotificationResult> {
  validateType(type);
  validatePayload(payload);

  const pref = await resolvePreference(userId, type);
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

  if (pref.channelPush) {
    try {
      await fanOutWebPush(
        userId,
        {
          title: payload.title,
          body: payload.body,
          severity: payload.severity ?? 'info',
          dataJson: payload.dataJson ?? null,
        },
        pushSender,
      );
    } catch {
      // Best-effort: a push fan-out failure must never break the in-app write.
    }
  }

  return { status: 'created', notification };
}

function serializeRow(
  row: NotificationPreference,
): SerializedNotificationPreference {
  return {
    type: row.type,
    channelInApp: row.channelInApp,
    channelEmail: row.channelEmail,
    channelPush: row.channelPush,
    digestDayOfWeek: row.digestDayOfWeek,
  };
}

function defaultsFor(type: string): SerializedNotificationPreference {
  return {
    type,
    channelInApp: NOTIFICATION_PREFERENCE_DEFAULTS.channelInApp,
    channelEmail: NOTIFICATION_PREFERENCE_DEFAULTS.channelEmail,
    channelPush: NOTIFICATION_PREFERENCE_DEFAULTS.channelPush,
    digestDayOfWeek: NOTIFICATION_PREFERENCE_DEFAULTS.digestDayOfWeek,
  };
}

/**
 * Validate a preference patch body. Pure function — exported for unit tests
 * and reused by the route handler. Missing fields are simply omitted from
 * the returned patch (they preserve the current value on upsert).
 */
export function validateNotificationPreferencePatch(
  raw: Record<string, unknown>,
):
  | { ok: true; patch: NotificationPreferencePatch }
  | { ok: false; error: string } {
  const patch: NotificationPreferencePatch = {};

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

  if (raw.channelPush !== undefined) {
    if (typeof raw.channelPush !== 'boolean') {
      return { ok: false, error: 'channelPush must be boolean' };
    }
    patch.channelPush = raw.channelPush;
  }

  if (raw.digestDayOfWeek !== undefined) {
    const d = raw.digestDayOfWeek;
    if (typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > 6) {
      return {
        ok: false,
        error: 'digestDayOfWeek must be an integer 0..6 (0=Sun … 6=Sat)',
      };
    }
    patch.digestDayOfWeek = d;
  }

  return { ok: true, patch };
}

/**
 * List the notification preferences for a user. Returns one row per *known*
 * type, where "known" means any of:
 *   (a) the user has an explicit preference row,
 *   (b) there's at least one notification row with that type for the user
 *       (so the Settings UI can list types the user has actually received
 *       notifications for, with the running defaults applied), or
 *   (c) the type is in the curated `WELL_KNOWN_NOTIFICATION_TYPES` set (so
 *       users can opt in/out before the first notification of that type fires).
 * For (b) and (c), the defaults (`channelInApp=true, channelEmail=false`) are
 * returned. The list is sorted by `type` ascending.
 */
export async function listNotificationPreferences(
  userId: number,
): Promise<SerializedNotificationPreference[]> {
  // Explicit preference rows.
  const rows = await NotificationPreference.findAll({
    where: { userId },
    order: [['type', 'ASC']],
  });
  const byType = new Map<string, SerializedNotificationPreference>();
  for (const row of rows) {
    byType.set(row.type, serializeRow(row));
  }

  // Inferred types from existing notifications. We use `findAll` + a Map
  // rather than DISTINCT to keep the SQL portable across dialects (sqlite
  // tests + postgres prod both run this code path verbatim).
  const seenTypes = new Set<string>(byType.keys());
  const notifs = await Notification.findAll({
    where: { userId },
    attributes: ['type'],
  });
  for (const n of notifs) {
    if (!seenTypes.has(n.type)) {
      byType.set(n.type, defaultsFor(n.type));
      seenTypes.add(n.type);
    }
  }

  // Always include curated well-known types so users can opt in/out before
  // the first notification of that type fires.
  for (const t of WELL_KNOWN_NOTIFICATION_TYPES) {
    if (!seenTypes.has(t)) {
      byType.set(t, defaultsFor(t));
      seenTypes.add(t);
    }
  }

  return Array.from(byType.values()).sort((a, b) =>
    a.type.localeCompare(b.type),
  );
}

/**
 * Upsert a single preference row for a user (issue #379). Creates the row with defaults if
 * it doesn't exist, then applies the patch. Fields absent from the patch keep
 * their current value (or the default if there was no row yet). Returns the
 * serialized row.
 */
export async function upsertNotificationPreference(
  userId: number,
  type: string,
  patch: NotificationPreferencePatch,
): Promise<SerializedNotificationPreference> {
  const [row] = await NotificationPreference.findOrCreate({
    where: { userId, type },
    defaults: {
      userId,
      type,
      channelInApp: NOTIFICATION_PREFERENCE_DEFAULTS.channelInApp,
      channelEmail: NOTIFICATION_PREFERENCE_DEFAULTS.channelEmail,
      channelPush: NOTIFICATION_PREFERENCE_DEFAULTS.channelPush,
      digestDayOfWeek: NOTIFICATION_PREFERENCE_DEFAULTS.digestDayOfWeek,
    },
  });

  if (patch.channelInApp !== undefined) {
    row.set('channelInApp', patch.channelInApp);
  }
  if (patch.channelEmail !== undefined) {
    row.set('channelEmail', patch.channelEmail);
  }
  if (patch.channelPush !== undefined) {
    row.set('channelPush', patch.channelPush);
  }
  if (patch.digestDayOfWeek !== undefined) {
    row.set('digestDayOfWeek', patch.digestDayOfWeek);
  }
  await row.save();

  return serializeRow(row);
}
