/**
 * Admin endpoints for the notification system (issue #267).
 *
 * Right now: a single "run digest for one user now" hook so operators can
 * manually verify the digest end-to-end (mailer config, template render,
 * in-app row creation) against a test user without waiting for the cron.
 *
 * Gating:
 *   - Superadmin only (`isSuperadmin`). All other auths get 403.
 *   - Rate-limited via `aiSuggestLimiter` (shared limiter). CodeQL flags
 *     authenticated routes that do work without a limiter — this one
 *     dispatches a digest send, which can trigger external SMTP, so the
 *     guard is warranted even though the caller is a superadmin.
 *
 * The endpoint runs the same `runWeeklyDigest` function the cron does so
 * the manual path and the scheduled path can't drift.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { isSuperadmin } from '../../auth/scope';
import { User } from '../../models';
import { runWeeklyDigest } from '../../notifications/runWeeklyDigest';
import { aiSuggestLimiter } from '../aiRateLimit';

const router = Router();

router.use((req: Request, res: Response, next: NextFunction) => {
  if (!isSuperadmin(req)) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  next();
});

router.post(
  '/digest/run-now',
  aiSuggestLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rawUserId = req.query.userId ?? req.body?.userId;
      const userId = Number(rawUserId);
      if (!Number.isInteger(userId) || userId <= 0) {
        res.status(400).json({ error: 'userId query/body param required' });
        return;
      }
      const user = await User.findByPk(userId, {
        attributes: ['id', 'email', 'displayName'],
      });
      if (!user) {
        res.status(404).json({ error: 'user not found' });
        return;
      }
      const result = await runWeeklyDigest(
        [
          {
            id: user.id,
            email: user.email,
            displayName: user.displayName,
          },
        ],
        new Date(),
      );
      res.json({ ok: true, result });
    } catch (e) {
      next(e);
    }
  },
);

export default router;
