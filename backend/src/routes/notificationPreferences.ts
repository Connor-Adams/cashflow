/**
 * DEPRECATED notification-preferences route — 410 Gone (issue #379).
 *
 * The standalone `/api/notification-preferences` endpoint was folded under the
 * user namespace as part of the primitives-spine convergence (Notification is
 * a delivery *transport*, a Support concern — preferences belong under the
 * user). The live endpoints now live at:
 *
 *   GET   /api/users/me/notifications/preferences
 *   PATCH /api/users/me/notifications/preferences/:type
 *
 * We return **410 Gone** rather than a redirect on purpose: a 410 surfaces any
 * stale client (the web app, a future mobile app, a cron job) loudly during
 * the migration window instead of silently masking it behind a 30x. The
 * response body names the replacement path so a developer sees exactly where
 * to go. The web frontend moved to the new path in this same change, so
 * nothing first-party should hit this handler.
 */
import { Router, type Request, type Response } from 'express';

const router = Router();

router.all(/.*/, (_req: Request, res: Response) => {
  res.status(410).json({
    error: 'gone',
    message:
      'This endpoint moved to /api/users/me/notifications/preferences (GET) ' +
      'and /api/users/me/notifications/preferences/:type (PATCH).',
  });
});

export default router;
