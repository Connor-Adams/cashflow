/**
 * PATCH /api/preferences/onboarding-dismiss — first-run onboarding (#259).
 *
 * Persists `cashflow_settings.onboarding_dismissed_at = now()` for the current
 * user so the import-creates-accounts wizard never shows again ("Skip for
 * now", AC #3). No request body. Idempotent: a second call refreshes the
 * timestamp and still returns 200. Returns `{ dismissedAt: ISO8601 }`.
 *
 * Mounted at /api/preferences behind the global requireAuth in app.ts.
 */
import { Router } from 'express';
import { currentAuth } from '../auth/middleware';
import { CashflowSettings } from '../models';

const router = Router();

router.patch('/onboarding-dismiss', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const [row] = await CashflowSettings.findOrCreate({
      where: { userId: user.id },
      defaults: { userId: user.id },
    });
    const now = new Date();
    row.set('onboardingDismissedAt', now);
    await row.save();
    res.json({ dismissedAt: now.toISOString() });
  } catch (e) {
    next(e);
  }
});

export default router;
