/**
 * Notification routes (issue #266). All endpoints are user-scoped via
 * `currentAuth(req).user.id`; we never accept a userId in the URL or body,
 * which is what guarantees AC #13 ("rows owned by another user are never
 * returned or modified").
 *
 * Endpoints:
 *   GET  /api/notifications                              list (paginated, newest-first)
 *   GET  /api/notifications/unread-count                { count }
 *   POST /api/notifications/:id/read                    mark one as read
 *   POST /api/notifications/mark-all-read               mark all unread as read
 *   GET  /api/users/me/notifications/preferences        list notification preferences
 *   PATCH /api/users/me/notifications/preferences/:type upsert one preference
 */
import { Router } from 'express';
import { Op } from 'sequelize';
import { currentAuth } from '../auth/middleware';
import { Notification, NotificationPreference } from '../models';
import { NOTIFICATION_SEVERITIES, NOTIFICATION_TYPE_MAX_LENGTH } from '../models/Notification';
import {
  NOTIFICATION_PREFERENCE_DEFAULTS,
} from '../models/NotificationPreference';

const router = Router();

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

type SerializedNotification = {
  id: number;
  type: string;
  severity: string;
  title: string;
  body: string;
  dataJson: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
};

function serialize(row: Notification): SerializedNotification {
  return {
    id: row.id,
    type: row.type,
    severity: row.severity,
    title: row.title,
    body: row.body,
    dataJson: row.dataJson ?? null,
    readAt: row.readAt ? row.readAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Pure helper — exported for the unit test. Clamps the limit query string
 *  to a sensible range and falls back to the default if missing/garbage. */
export function parseLimit(raw: unknown): number {
  if (raw == null || raw === '') return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

/** Pure helper — exported for the unit test. Coerces `unreadOnly=true|1` to
 *  a boolean; anything else is treated as false. */
export function parseUnreadOnly(raw: unknown): boolean {
  if (raw === 'true' || raw === '1' || raw === true) return true;
  return false;
}

router.get('/', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const limit = parseLimit(req.query.limit);
    const unreadOnly = parseUnreadOnly(req.query.unreadOnly);

    const where: Record<string, unknown> = { userId: user.id };
    if (unreadOnly) {
      where.readAt = { [Op.is]: null };
    }

    const rows = await Notification.findAll({
      where,
      order: [['createdAt', 'DESC']],
      limit,
    });

    res.json({ data: rows.map(serialize) });
  } catch (e) {
    next(e);
  }
});

router.get('/unread-count', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const count = await Notification.count({
      where: {
        userId: user.id,
        readAt: { [Op.is]: null },
      },
    });
    res.json({ count });
  } catch (e) {
    next(e);
  }
});

router.post('/:id/read', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: 'id must be a positive integer' });
      return;
    }

    // Scope by userId so we never expose another user's row even via 404.
    const row = await Notification.findOne({
      where: { id, userId: user.id },
    });
    if (!row) {
      res.status(404).json({ error: 'Notification not found' });
      return;
    }

    if (!row.readAt) {
      row.readAt = new Date();
      await row.save();
    }

    res.json(serialize(row));
  } catch (e) {
    next(e);
  }
});

router.post('/mark-all-read', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const [updated] = await Notification.update(
      { readAt: new Date() },
      {
        where: {
          userId: user.id,
          readAt: { [Op.is]: null },
        },
      },
    );
    res.json({ updated });
  } catch (e) {
    next(e);
  }
});

/** Severity list re-exported so the frontend can mirror the same set
 *  without duplicating the literal. Mostly defensive — the route file is
 *  a natural source of truth for the wire shape. */
export const ROUTE_SEVERITIES = NOTIFICATION_SEVERITIES;

// ---------------------------------------------------------------------------
// Notification preferences — folded from notificationPreferences.ts (#379)
// Mounted separately in app.ts at /api/users/me/notifications/preferences.
// ---------------------------------------------------------------------------

export const preferencesRouter = Router();

export type SerializedNotificationPreference = {
  type: string;
  channelInApp: boolean;
  channelEmail: boolean;
};

function serializePreferenceRow(row: NotificationPreference): SerializedNotificationPreference {
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

preferencesRouter.get('/', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);

    // Explicit preference rows.
    const rows = await NotificationPreference.findAll({
      where: { userId: user.id },
      order: [['type', 'ASC']],
    });
    const byType = new Map<string, SerializedNotificationPreference>();
    for (const row of rows) {
      byType.set(row.type, serializePreferenceRow(row));
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

preferencesRouter.patch('/:type', async (req, res, next) => {
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

    res.json(serializePreferenceRow(row));
  } catch (e) {
    next(e);
  }
});

export default router;
