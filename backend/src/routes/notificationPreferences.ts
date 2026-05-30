/**
 * GONE (#379) — notification preferences have moved to
 * /api/users/me/notifications/preferences. This stub returns 410 so that
 * any client still pointing at the old path gets a clear, non-retryable
 * signal to update.
 */
import { Router } from 'express';

const router = Router();

router.all('*', (_req, res) => {
  res.status(410).json({
    error:
      'This endpoint has moved. Use /api/users/me/notifications/preferences instead.',
  });
});

export default router;
