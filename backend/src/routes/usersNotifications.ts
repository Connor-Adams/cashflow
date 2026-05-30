/**
 * User-namespaced notification routes (issue #379).
 *
 * Primitives-spine convergence folds the standalone `/api/notification-
 * preferences` route under the user namespace: preferences belong logically
 * *under* the user, so they live at `/api/users/me/notifications/preferences`.
 * This router is mounted at `/api/users/me/notifications`.
 *
 * The actual preference list/upsert logic lives in the single notification
 * service module (`src/notifications/index.ts`) — this file is a thin HTTP
 * adapter. All endpoints are user-scoped via `currentAuth(req).user.id`; we
 * never accept a userId in the URL or body.
 *
 * Endpoints:
 *   GET   /api/users/me/notifications/preferences
 *     → one row per *known* type (explicit rows + types inferred from the
 *       notifications table + curated well-known types), defaults applied.
 *
 *   PATCH /api/users/me/notifications/preferences/:type
 *     → upsert the preference row. Body: { channelInApp?, channelEmail? }.
 *       Missing fields preserve their current value (or the default if there
 *       was no row yet).
 */
import { Router } from 'express';
import { currentAuth } from '../auth/middleware';
import { NOTIFICATION_TYPE_MAX_LENGTH } from '../models/Notification';
import {
  listNotificationPreferences,
  upsertNotificationPreference,
  validateNotificationPreferencePatch,
} from '../notifications/index';

const router = Router();

router.get('/preferences', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const data = await listNotificationPreferences(user.id);
    res.json({ data });
  } catch (e) {
    next(e);
  }
});

router.patch('/preferences/:type', async (req, res, next) => {
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

    const saved = await upsertNotificationPreference(user.id, type, result.patch);
    res.json(saved);
  } catch (e) {
    next(e);
  }
});

export default router;
