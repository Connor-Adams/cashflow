/**
 * Preferences routes — user-level persistent settings.
 *
 * GET  /api/preferences                — read all user preferences
 * PATCH /api/preferences               — update sidebarCollapsedSections (#290)
 *                                        and lastSeenChangelogVersion (#294)
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

/** Changelog version format: YYYY-MM-DD-N (#294) */
const CHANGELOG_VERSION_RE = /^\d{4}-\d{2}-\d{2}-\d+$/;

/**
 * GET /api/preferences — return current user preferences.
 * Returns `{ sidebarCollapsedSections: string[], lastSeenChangelogVersion: string | null }`.
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
      lastSeenChangelogVersion: row.lastSeenChangelogVersion ?? null,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * PATCH /api/preferences — update user preferences.
 * Accepts `{ sidebarCollapsedSections?: string[], lastSeenChangelogVersion?: string }`.
 * Returns 400 with `{ error: 'INVALID_SECTION_ID' }` if any section ID is invalid.
 * Returns 400 with `{ error: 'INVALID_VERSION' }` if the version format is wrong.
 */
router.patch('/', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const { sidebarCollapsedSections, lastSeenChangelogVersion } = req.body as {
      sidebarCollapsedSections?: unknown;
      lastSeenChangelogVersion?: unknown;
    };

    // Validate fields before touching the DB
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
    }

    if (lastSeenChangelogVersion !== undefined) {
      if (
        typeof lastSeenChangelogVersion !== 'string' ||
        !CHANGELOG_VERSION_RE.test(lastSeenChangelogVersion)
      ) {
        res.status(400).json({ error: 'INVALID_VERSION' });
        return;
      }
    }

    if (sidebarCollapsedSections === undefined && lastSeenChangelogVersion === undefined) {
      res.status(400).json({ error: 'NO_VALID_FIELD' });
      return;
    }

    const [row] = await CashflowSettings.findOrCreate({
      where: { userId: user.id },
      defaults: { userId: user.id },
    });

    if (sidebarCollapsedSections !== undefined) {
      row.sidebarCollapsedSections = sidebarCollapsedSections as string[];
    }
    if (lastSeenChangelogVersion !== undefined) {
      row.lastSeenChangelogVersion = lastSeenChangelogVersion as string;
    }

    await row.save();

    res.json({
      sidebarCollapsedSections: row.sidebarCollapsedSections,
      lastSeenChangelogVersion: row.lastSeenChangelogVersion ?? null,
    });
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
