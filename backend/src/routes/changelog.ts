/**
 * Changelog routes — serve in-app What's New entries.
 *
 * GET /api/changelog?since=<version>&audience=user
 *   Returns user-audience entries newer than `since` (version > since,
 *   lexicographic). If `since` is omitted, returns all entries. Newest first.
 *
 * GET /api/changelog/latest?audience=user
 *   Returns the single latest user-audience entry, or { empty: true } if none.
 *
 * Mounted at /api/changelog behind the global requireAuth in app.ts.
 * Issue #294 — in-app What's New changelog surface.
 */
import { Router } from 'express';
import { readChangelogEntries, getLatestEntry } from '../services/changelogService';

const router = Router();

/**
 * GET /api/changelog/latest?audience=user
 * Returns the latest user-audience changelog entry or { empty: true }.
 */
router.get('/latest', async (_req, res, next) => {
  try {
    const entry = await getLatestEntry('user');
    if (!entry) {
      res.json({ empty: true });
      return;
    }
    res.json(entry);
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/changelog?since=<version>&audience=user
 * Returns all user-audience entries (newest first), optionally filtered by
 * `since`: only entries whose version is lexicographically greater are returned.
 */
router.get('/', async (req, res, next) => {
  try {
    const since = typeof req.query['since'] === 'string' ? req.query['since'] : null;
    let entries = await readChangelogEntries();

    // Filter to user audience only
    entries = entries.filter((e) => e.audience === 'user');

    // Apply since filter if provided
    if (since) {
      entries = entries.filter((e) => e.version > since);
    }

    res.json(entries);
  } catch (e) {
    next(e);
  }
});

export default router;
