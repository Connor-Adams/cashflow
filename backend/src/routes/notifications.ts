/**
 * Notification routes (issue #266). All endpoints are user-scoped via
 * `currentAuth(req).user.id`; we never accept a userId in the URL or body,
 * which is what guarantees AC #13 ("rows owned by another user are never
 * returned or modified").
 *
 * Endpoints:
 *   GET /api/notifications                    list (paginated, newest-first)
 *   GET /api/notifications/unread-count       { count }
 *   POST /api/notifications/:id/read          mark one as read
 *   POST /api/notifications/mark-all-read     mark all unread as read
 */
import { Router } from 'express';
import { Op } from 'sequelize';
import { currentAuth } from '../auth/middleware';
import { Notification } from '../models';

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

export default router;
