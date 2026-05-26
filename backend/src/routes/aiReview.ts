/**
 * AI finance review inbox routes (issue #210).
 *
 * Endpoints:
 *   POST /api/ai/review               — create a review run for a period
 *   GET  /api/ai/reviews              — list runs for the caller's household
 *   GET  /api/ai/reviews/:id          — single run with action items
 *   POST /api/ai/reviews/:id/items/:itemId/accept
 *   POST /api/ai/reviews/:id/items/:itemId/dismiss
 *
 * The review run is generated SYNCHRONOUSLY for now — the deterministic
 * pipeline (insights + rule proposals + missing-receipts + subscription
 * heuristic + overdue planned events) returns in well under the request
 * timeout for a typical household's monthly window. If the work needs to
 * move async, swap the create handler to enqueue a job and flip status to
 * 'pending' without changing the response contract.
 */
import { Router } from 'express';
import { Op } from 'sequelize';
import { AiReviewRun } from '../models';
import {
  AI_REVIEW_ACTION_ITEM_STATUSES,
  type AiReviewActionItem,
  type AiReviewActionItemStatus,
} from '../models/AiReviewRun';
import { currentAuth } from '../auth/middleware';
import { householdWhere } from '../auth/scope';
import { rejectDemoAiRequest } from '../demo/aiAccess';
import { buildReviewActionItems, AI_REVIEW_PROMPT_VERSION } from '../ai/reviewRunner';
import { aiSuggestLimiter } from './aiRateLimit';

const router = Router();

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface CreateReviewBody {
  periodStart?: unknown;
  periodEnd?: unknown;
  currency?: unknown;
}

function validateCreate(body: CreateReviewBody):
  | { ok: true; value: { periodStart: string; periodEnd: string; currency: string } }
  | { ok: false; status: number; error: string } {
  const periodStart = String(body.periodStart ?? '').trim();
  if (!ISO_DATE_RE.test(periodStart)) {
    return { ok: false, status: 400, error: 'periodStart must be YYYY-MM-DD' };
  }
  const periodEnd = String(body.periodEnd ?? '').trim();
  if (!ISO_DATE_RE.test(periodEnd)) {
    return { ok: false, status: 400, error: 'periodEnd must be YYYY-MM-DD' };
  }
  if (periodStart > periodEnd) {
    return { ok: false, status: 400, error: 'periodStart must be on or before periodEnd' };
  }
  const currencyRaw = body.currency == null || body.currency === ''
    ? 'CAD'
    : String(body.currency).toUpperCase().trim();
  if (currencyRaw.length !== 3) {
    return { ok: false, status: 400, error: 'currency must be a 3-letter ISO code' };
  }
  return {
    ok: true,
    value: { periodStart, periodEnd, currency: currencyRaw },
  };
}

interface SerializedAiReviewRun {
  id: number;
  householdId: number;
  userId: number;
  periodStart: string;
  periodEnd: string;
  currency: string;
  status: string;
  summary: string | null;
  actionItems: AiReviewActionItem[];
  model: string | null;
  promptVersion: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

function serialize(row: AiReviewRun): SerializedAiReviewRun {
  return {
    id: row.id,
    householdId: row.householdId,
    userId: row.userId,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    currency: row.currency,
    status: row.status,
    summary: row.summary,
    actionItems: Array.isArray(row.actionItems) ? row.actionItems : [],
    model: row.model,
    promptVersion: row.promptVersion,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

router.post('/review', aiSuggestLimiter, async (req, res, next) => {
  try {
    if (rejectDemoAiRequest(req, res)) return;
    const validated = validateCreate((req.body ?? {}) as CreateReviewBody);
    if (!validated.ok) {
      res.status(validated.status).json({ error: validated.error });
      return;
    }
    const { user, household } = currentAuth(req);
    const { periodStart, periodEnd, currency } = validated.value;

    let actionItems: AiReviewActionItem[] = [];
    let summary: string | null = null;
    let status: 'completed' | 'failed' = 'completed';
    let errorMessage: string | null = null;
    try {
      const built = await buildReviewActionItems({
        req,
        householdId: household.id,
        periodStart,
        periodEnd,
        currency,
      });
      actionItems = built.actionItems;
      summary = built.summary;
    } catch (e) {
      status = 'failed';
      errorMessage = e instanceof Error ? e.message : 'Unknown error';
    }

    const row = await AiReviewRun.create({
      householdId: household.id,
      userId: user.id,
      periodStart,
      periodEnd,
      currency,
      status,
      summary,
      actionItems,
      model: 'deterministic',
      promptVersion: AI_REVIEW_PROMPT_VERSION,
      errorMessage,
    });

    res.status(201).json(serialize(row));
  } catch (e) {
    next(e);
  }
});

router.get('/reviews', async (req, res, next) => {
  try {
    const where: Record<string, unknown> = { ...householdWhere(req) };
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
    if (req.query.status) {
      const s = String(req.query.status);
      if (s === 'pending' || s === 'completed' || s === 'failed') where.status = s;
    }
    if (req.query.dateFrom) {
      const f = String(req.query.dateFrom);
      if (ISO_DATE_RE.test(f)) {
        where.periodStart = {
          ...(where.periodStart as Record<symbol, string> | undefined),
          [Op.gte]: f,
        };
      }
    }
    if (req.query.dateTo) {
      const t = String(req.query.dateTo);
      if (ISO_DATE_RE.test(t)) {
        where.periodEnd = {
          ...(where.periodEnd as Record<symbol, string> | undefined),
          [Op.lte]: t,
        };
      }
    }
    const rows = await AiReviewRun.findAll({
      where,
      order: [['createdAt', 'DESC']],
      limit,
    });
    res.json({ data: rows.map(serialize) });
  } catch (e) {
    next(e);
  }
});

router.get('/reviews/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const row = await AiReviewRun.findOne({
      where: { id, ...householdWhere(req) },
    });
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json(serialize(row));
  } catch (e) {
    next(e);
  }
});

/**
 * Set a single action item's status. Used by the accept/dismiss endpoints
 * below. Pure function — exported only for testing.
 */
export function updateActionItemStatus(
  items: AiReviewActionItem[],
  itemId: string,
  newStatus: AiReviewActionItemStatus,
): { ok: true; items: AiReviewActionItem[] } | { ok: false } {
  if (!AI_REVIEW_ACTION_ITEM_STATUSES.includes(newStatus)) return { ok: false };
  const idx = items.findIndex((it) => it.id === itemId);
  if (idx < 0) return { ok: false };
  const next = items.slice();
  next[idx] = { ...next[idx], status: newStatus };
  return { ok: true, items: next };
}

async function mutateItemStatus(
  req: Parameters<typeof currentAuth>[0],
  runId: number,
  itemId: string,
  status: AiReviewActionItemStatus,
): Promise<
  | { ok: true; row: AiReviewRun }
  | { ok: false; status: number; error: string }
> {
  const row = await AiReviewRun.findOne({ where: { id: runId, ...householdWhere(req) } });
  if (!row) return { ok: false, status: 404, error: 'Not found' };
  const current = Array.isArray(row.actionItems) ? row.actionItems : [];
  const result = updateActionItemStatus(current, itemId, status);
  if (!result.ok) {
    return { ok: false, status: 404, error: 'Action item not found' };
  }
  // Sequelize JSON columns: re-assign by setting the field to a new array
  // reference so the dirty tracker picks it up.
  row.actionItems = result.items;
  row.changed('actionItems', true);
  await row.save();
  return { ok: true, row };
}

router.post('/reviews/:id/items/:itemId/accept', async (req, res, next) => {
  try {
    const runId = Number(req.params.id);
    if (!Number.isInteger(runId) || runId < 1) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const itemId = String(req.params.itemId);
    const out = await mutateItemStatus(req, runId, itemId, 'accepted');
    if (!out.ok) {
      res.status(out.status).json({ error: out.error });
      return;
    }
    res.json(serialize(out.row));
  } catch (e) {
    next(e);
  }
});

router.post('/reviews/:id/items/:itemId/dismiss', async (req, res, next) => {
  try {
    const runId = Number(req.params.id);
    if (!Number.isInteger(runId) || runId < 1) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const itemId = String(req.params.itemId);
    const out = await mutateItemStatus(req, runId, itemId, 'dismissed');
    if (!out.ok) {
      res.status(out.status).json({ error: out.error });
      return;
    }
    res.json(serialize(out.row));
  } catch (e) {
    next(e);
  }
});

export default router;
