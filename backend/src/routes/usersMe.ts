/**
 * /api/users/me routes (issue #379).
 *
 * Endpoints:
 *   GET  /api/users/me/notifications/preferences
 *   PATCH /api/users/me/notifications/preferences/:type
 *
 * The preference logic was previously at /api/notification-preferences (now
 * returning 410 Gone). All business logic is retained here verbatim.
 */
import { Router } from 'express';
import { currentAuth } from '../auth/middleware';
import { Notification, NotificationPreference } from '../models';
import { NOTIFICATION_PREFERENCE_DEFAULTS } from '../models/NotificationPreference';
import { NOTIFICATION_TYPE_MAX_LENGTH } from '../models/Notification';
import {
  WELL_KNOWN_NOTIFICATION_TYPES,
  validateNotificationPreferencePatch,
} from './notificationPreferences';
import type { SerializedNotificationPreference } from './notificationPreferences';

const router = Router();

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

router.get('/notifications/preferences', async (req, res, next) => {
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

    // Inferred types from existing notifications.
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

    // Always include curated well-known types so users can opt in/out
    // before the first notification of that type fires.
    for (const t of WELL_KNOWN_NOTIFICATION_TYPES) {
      if (!seenTypes.has(t)) {
        byType.set(t, defaultsFor(t));
        seenTypes.add(t);
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

router.patch('/notifications/preferences/:type', async (req, res, next) => {
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
