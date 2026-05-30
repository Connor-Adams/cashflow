/**
 * Preferences routes — user-level persistent settings.
 *
 * GET  /api/preferences                — read all user preferences
 * PATCH /api/preferences               — update sidebarCollapsedSections (#290)
 * PATCH /api/preferences/onboarding-dismiss — first-run onboarding (#259)
 *
 * Mounted at /api/preferences behind the global requireAuth in app.ts.
 */
import { Router } from 'express';
import { currentAuth } from '../auth/middleware';
import { CashflowSettings } from '../models';

const router = Router();

/** Valid sidebar section IDs for #290 */
const VALID_SECTION_IDS = ['today', 'money', 'planning', 'investments', 'insights-rules'] as const;

/**
 * GET /api/preferences — return current user preferences.
 * Returns `{ sidebarCollapsedSections: string[] }`.
 */
router.get('/', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const [row] = await CashflowSettings.findOrCreate({
      where: { userId: user.id },
      defaults: { userId: user.id },
    });
    res.json({
      sidebarCollapsedSections: row.sidebarCollapsedSections ?? [],
    });
  } catch (e) {
    next(e);
  }
});

/**
 * PATCH /api/preferences — update user preferences.
 * Accepts `{ sidebarCollapsedSections: string[] }`.
 * Returns 400 with `{ error: 'INVALID_SECTION_ID' }` if any entry is invalid.
 */
router.patch('/', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const { sidebarCollapsedSections } = req.body as { sidebarCollapsedSections?: unknown };

    if (sidebarCollapsedSections !== undefined) {
      if (
        !Array.isArray(sidebarCollapsedSections) ||
        sidebarCollapsedSections.some(
          (id) => !VALID_SECTION_IDS.includes(id as (typeof VALID_SECTION_IDS)[number]),
        )
      ) {
        res.status(400).json({ error: 'INVALID_SECTION_ID' });
        return;
      }

      const [row] = await CashflowSettings.findOrCreate({
        where: { userId: user.id },
        defaults: { userId: user.id },
      });
      row.sidebarCollapsedSections = sidebarCollapsedSections as string[];
      await row.save();
      res.json({ sidebarCollapsedSections: row.sidebarCollapsedSections });
      return;
    }

    res.status(400).json({ error: 'NO_VALID_FIELD' });
  } catch (e) {
    next(e);
  }
});

/**
 * PATCH /api/preferences/onboarding-dismiss — first-run onboarding (#259).
 * No request body. Idempotent. Returns `{ dismissedAt: ISO8601 }`.
 */
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
