import { Router } from 'express';
import { currentAuth } from '../auth/middleware';
import { User } from '../models';
import { changelogDir } from '../config/env';
import {
  loadChangelog,
  userEntries,
  isUnread,
  entriesSince,
} from '../services/changelog';

const router = Router();
const VERSION_RE = /^v\d+\.\d+\.\d+$/;

export function validateSeenPatch(
  raw: Record<string, unknown>,
): { ok: true; version: string } | { ok: false; error: string } {
  const v = String(raw.version ?? '');
  if (!VERSION_RE.test(v)) return { ok: false, error: 'INVALID_VERSION' };
  return { ok: true, version: v };
}

router.get('/latest', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const visible = userEntries(loadChangelog(changelogDir).entries);
    if (visible.length === 0) {
      res.json({ empty: true });
      return;
    }
    const row = await User.findByPk(user.id);
    const lastSeen = row?.lastSeenChangelogVersion ?? null;
    const top = visible[0];
    res.json({
      version: top.version,
      title: top.title,
      publishedAt: top.publishedAt,
      html: top.html,
      unread: isUnread(top, lastSeen, visible),
    });
  } catch (e) {
    next(e);
  }
});

router.get('/overview', async (req, res, next) => {
  try {
    currentAuth(req);
    const { overview } = loadChangelog(changelogDir);
    if (!overview) {
      res.json({ empty: true });
      return;
    }
    res.json(overview);
  } catch (e) {
    next(e);
  }
});

router.get('/', async (req, res, next) => {
  try {
    currentAuth(req);
    const since = typeof req.query.since === 'string' ? req.query.since : null;
    const visible = entriesSince(userEntries(loadChangelog(changelogDir).entries), since);
    res.json({
      entries: visible.map((e) => ({
        version: e.version,
        title: e.title,
        publishedAt: e.publishedAt,
        html: e.html,
      })),
    });
  } catch (e) {
    next(e);
  }
});

router.patch('/seen', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const result = validateSeenPatch((req.body ?? {}) as Record<string, unknown>);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    const row = await User.findByPk(user.id);
    if (!row) {
      res.status(404).json({ error: 'USER_NOT_FOUND' });
      return;
    }
    row.set('lastSeenChangelogVersion', result.version);
    await row.save();
    res.json({ ok: true, lastSeenChangelogVersion: result.version });
  } catch (e) {
    next(e);
  }
});

export default router;
