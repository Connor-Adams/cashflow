/**
 * Notification preference routes (issue #266). All endpoints scoped to the
 * authenticated user via `currentAuth(req).user.id`.
 *
 * Endpoints:
 *   GET /api/notification-preferences
 *     → one row per *known* type, where "known" means either:
 *       (a) the user has an explicit preference row, or
 *       (b) there's at least one notification row with that type for the
 *           user (so the Settings UI can list types the user has actually
 *           received notifications for, with the running defaults applied).
 *     For (b), returns the defaults (`channelInApp=true, channelEmail=false`).
 *
 *   PATCH /api/notification-preferences/:type
 *     → upsert the preference row. Body: { channelInApp?, channelEmail? }.
 *     Missing fields preserve their current value (or the default if there
 *     was no row yet).
 */
import { Router } from 'express';
import { currentAuth } from '../auth/middleware';
import { Notification, NotificationPreference } from '../models';
import {
  NOTIFICATION_PREFERENCE_DEFAULTS,
} from '../models/NotificationPreference';
import { NOTIFICATION_TYPE_MAX_LENGTH } from '../models/Notification';

const router = Router();

export type SerializedNotificationPreference = {
  type: string;
  channelInApp: boolean;
  channelEmail: boolean;
};

function serializeRow(row: NotificationPreference): SerializedNotificationPreference {
  return {
    type: row.type,
    channelInApp: row.channelInApp,
    channelEmail: row.channelEmail,
  };
}

function defaultsFor(type: string): SerializedNotificationPreference {
  return {
    type,
    channelInApp: NOTIFICATION_PREFERENCE_DEFAULTS.channelInApp,
    channelEmail: NOTIFICATION_PREFERENCE_DEFAULTS.channelEmail,
  };
}

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

router.get('/', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);

    // Explicit preference rows.
    const rows = await NotificationPreference.findAll({
      where: { userId: user.id },
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
      where: { userId: user.id },
      attributes: ['type'],
    });
    for (const n of notifs) {
      if (!seenTypes.has(n.type)) {
        byType.set(n.type, defaultsFor(n.type));
        seenTypes.add(n.type);
      }
    }

    const data = Array.from(byType.values()).sort((a, b) =>
      a.type.localeCompare(b.type),
    );
    res.json({ data });
  } catch (e) {
    next(e);
  }
});

router.patch('/:type', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const type = String(req.params.type ?? '');
    if (!type || type.length > NOTIFICATION_TYPE_MAX_LENGTH) {
      res.status(400).json({
        error: `type must be 1-${NOTIFICATION_TYPE_MAX_LENGTH} chars`,
      });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = validateNotificationPreferencePatch(body);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }

    const [row] = await NotificationPreference.findOrCreate({
      where: { userId: user.id, type },
      defaults: {
        userId: user.id,
        type,
        channelInApp: NOTIFICATION_PREFERENCE_DEFAULTS.channelInApp,
        channelEmail: NOTIFICATION_PREFERENCE_DEFAULTS.channelEmail,
      },
    });

    if (result.patch.channelInApp !== undefined) {
      row.set('channelInApp', result.patch.channelInApp);
    }
    if (result.patch.channelEmail !== undefined) {
      row.set('channelEmail', result.patch.channelEmail);
    }
    await row.save();

    res.json(serializeRow(row));
  } catch (e) {
    next(e);
  }
});

export default router;
