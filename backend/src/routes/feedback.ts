/**
 * In-app feedback / bug reporting routes (issue #295).
 *
 * Mounted on `/api` behind the global `requireAuth` guard:
 *   POST /api/feedback              — create a submission (per-user rate limit)
 *   GET  /api/feedback              — owner-only, newest-first, paginated
 *   POST /api/feedback/:id/resolve  — owner-only, stamp resolved_at
 *
 * Scope: the collection is household-scoped via `householdWhere`. Read/resolve
 * are restricted to the household owner (or a superadmin); creation is open to
 * any authenticated member so anyone can send feedback. On a successful save
 * the route optionally forwards a sanitized payload to FEEDBACK_WEBHOOK_URL;
 * that forward never throws, so a webhook failure cannot affect the response.
 */
import { Router } from 'express';
import { Feedback } from '../models';
import { currentAuth } from '../auth/middleware';
import { householdWhere, isHouseholdOwner } from '../auth/scope';
import { feedbackLimiter } from './feedbackRateLimit';
import { validateFeedback } from '../feedback/validate';
import { forwardFeedback } from '../services/feedbackWebhook';

const router = Router();

type SerializedFeedback = {
  id: number;
  category: string;
  body: string;
  currentPath: string | null;
  appVersion: string | null;
  userAgent: string | null;
  createdAt: string;
  resolvedAt: string | null;
};

function serialize(f: Feedback): SerializedFeedback {
  return {
    id: f.id,
    category: f.category,
    body: f.body,
    currentPath: f.currentPath,
    appVersion: f.appVersion,
    userAgent: f.userAgent,
    createdAt: f.createdAt.toISOString(),
    resolvedAt: f.resolvedAt ? f.resolvedAt.toISOString() : null,
  };
}

function parseLimit(raw: unknown, fallback = 50, max = 200): number {
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function parseOffset(raw: unknown): number {
  if (raw == null || raw === '') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

// ----- POST /api/feedback -------------------------------------------------

router.post('/feedback', feedbackLimiter, async (req, res, next) => {
  try {
    const auth = currentAuth(req);
    const v = validateFeedback((req.body || {}) as Record<string, unknown>);
    if (!v.ok) {
      res.status(v.status).json({ error: v.error });
      return;
    }
    const userAgent = req.headers['user-agent'];
    const created = await Feedback.create({
      householdId: auth.household.id,
      userId: auth.user.id,
      category: v.value.category,
      body: v.value.body,
      currentPath: v.value.currentPath,
      userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 512) : null,
      appVersion: v.value.appVersion,
      resolvedAt: null,
    });
    // Sanitized fire-and-forget forward. forwardFeedback never throws, so
    // awaiting it here is safe and keeps the webhook path deterministic in
    // tests; a webhook failure is swallowed and cannot fail the submission.
    await forwardFeedback({
      id: created.id,
      category: v.value.category,
      body: v.value.body,
      currentPath: v.value.currentPath,
      appVersion: v.value.appVersion,
      createdAt: created.createdAt.toISOString(),
    });
    res.status(201).json({ id: created.id });
  } catch (e) {
    next(e);
  }
});

// ----- GET /api/feedback --------------------------------------------------

router.get('/feedback', async (req, res, next) => {
  try {
    if (!isHouseholdOwner(req)) {
      res.status(403).json({ error: 'FORBIDDEN' });
      return;
    }
    const rows = await Feedback.findAll({
      where: { ...householdWhere(req) },
      order: [['created_at', 'DESC']],
      limit: parseLimit(req.query.limit),
      offset: parseOffset(req.query.offset),
    });
    const data = rows.map(serialize);
    res.json({ data, count: data.length });
  } catch (e) {
    next(e);
  }
});

// ----- POST /api/feedback/:id/resolve -------------------------------------

router.post('/feedback/:id/resolve', async (req, res, next) => {
  try {
    if (!isHouseholdOwner(req)) {
      res.status(403).json({ error: 'FORBIDDEN' });
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const row = await Feedback.findOne({
      where: { id, ...householdWhere(req) },
    });
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    row.resolvedAt = new Date();
    await row.save();
    res.json(serialize(row));
  } catch (e) {
    next(e);
  }
});

export default router;
