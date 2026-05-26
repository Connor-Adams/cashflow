/**
 * Personal CFO briefing routes (issue #236).
 *
 * Endpoints:
 *   POST /api/cfo/briefings                          — generate a briefing
 *   GET  /api/cfo/briefings                          — list household briefings
 *   GET  /api/cfo/briefings/:id                      — single briefing detail
 *   POST /api/cfo/briefings/:id/items/:itemId/resolve
 *   POST /api/cfo/briefings/:id/items/:itemId/dismiss
 *
 * Generated synchronously: the deterministic pipeline (insights + rule
 * proposals + missing-receipts + subscriptions + planned-events overdue
 * + safe-to-spend + import-history + review-backlog) finishes well under
 * the request timeout for a typical household over a daily/weekly
 * window. If the work needs to move async, swap the create handler to
 * enqueue a job and flip status to 'pending' without breaking the
 * response contract.
 */
import { Router } from 'express';
import { Op } from 'sequelize';
import { CfoBriefing } from '../models';
import {
  CFO_BRIEFING_ACTION_ITEM_STATUSES,
  type CfoBriefingActionItem,
  type CfoBriefingActionItemStatus,
  type CfoBriefingSafeToSpendSnapshot,
} from '../models/CfoBriefing';
import { currentAuth } from '../auth/middleware';
import { householdWhere } from '../auth/scope';
import { rejectDemoAiRequest } from '../demo/aiAccess';
import {
  buildCfoBriefing,
  CFO_BRIEFING_PROMPT_VERSION,
  MAX_BRIEFING_WINDOW_DAYS,
  resolveDefaultBriefingPeriod,
} from '../cfo/briefingBuilder';
import { aiSuggestLimiter } from './aiRateLimit';

const router = Router();

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function todayIso(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
    d.getUTCDate(),
  ).padStart(2, '0')}`;
}

function daysBetween(a: string, b: string): number {
  const aMs = Date.parse(`${a}T00:00:00Z`);
  const bMs = Date.parse(`${b}T00:00:00Z`);
  return Math.round((bMs - aMs) / MS_PER_DAY) + 1; // inclusive
}

interface CreateBody {
  periodStart?: unknown;
  periodEnd?: unknown;
  currency?: unknown;
}

function validateCreate(
  body: CreateBody,
):
  | { ok: true; value: { periodStart: string; periodEnd: string; currency: string } }
  | { ok: false; status: number; error: string } {
  // periodStart/periodEnd default to "last 7 days through today".
  const asOf = todayIso();
  const defaults = resolveDefaultBriefingPeriod(asOf);
  const periodStart =
    body.periodStart == null || body.periodStart === ''
      ? defaults.periodStart
      : String(body.periodStart).trim();
  if (!ISO_DATE_RE.test(periodStart)) {
    return { ok: false, status: 400, error: 'periodStart must be YYYY-MM-DD' };
  }
  const periodEnd =
    body.periodEnd == null || body.periodEnd === ''
      ? defaults.periodEnd
      : String(body.periodEnd).trim();
  if (!ISO_DATE_RE.test(periodEnd)) {
    return { ok: false, status: 400, error: 'periodEnd must be YYYY-MM-DD' };
  }
  if (periodStart > periodEnd) {
    return {
      ok: false,
      status: 400,
      error: 'periodStart must be on or before periodEnd',
    };
  }
  if (daysBetween(periodStart, periodEnd) > MAX_BRIEFING_WINDOW_DAYS) {
    return {
      ok: false,
      status: 400,
      error: `briefing window must be at most ${MAX_BRIEFING_WINDOW_DAYS} days`,
    };
  }
  const currencyRaw =
    body.currency == null || body.currency === ''
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

interface SerializedCfoBriefing {
  id: number;
  householdId: number;
  userId: number;
  periodStart: string;
  periodEnd: string;
  currency: string;
  status: string;
  summary: string | null;
  actionItems: CfoBriefingActionItem[];
  safeToSpendSnapshot: CfoBriefingSafeToSpendSnapshot | null;
  model: string | null;
  promptVersion: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

function serialize(row: CfoBriefing): SerializedCfoBriefing {
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
    safeToSpendSnapshot: row.safeToSpendSnapshot ?? null,
    model: row.model,
    promptVersion: row.promptVersion,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

router.post('/briefings', aiSuggestLimiter, async (req, res, next) => {
  try {
    if (rejectDemoAiRequest(req, res)) return;
    const validated = validateCreate((req.body ?? {}) as CreateBody);
    if (!validated.ok) {
      res.status(validated.status).json({ error: validated.error });
      return;
    }
    const { user, household } = currentAuth(req);
    const { periodStart, periodEnd, currency } = validated.value;

    let actionItems: CfoBriefingActionItem[] = [];
    let summary: string | null = null;
    let safeToSpendSnapshot: CfoBriefingSafeToSpendSnapshot | null = null;
    let status: 'completed' | 'failed' = 'completed';
    let errorMessage: string | null = null;
    try {
      const built = await buildCfoBriefing({
        req,
        householdId: household.id,
        userId: user.id,
        periodStart,
        periodEnd,
        currency,
      });
      actionItems = built.actionItems;
      summary = built.summary;
      safeToSpendSnapshot = built.safeToSpendSnapshot;
    } catch (e) {
      status = 'failed';
      errorMessage = e instanceof Error ? e.message : 'Unknown error';
    }

    const row = await CfoBriefing.create({
      householdId: household.id,
      userId: user.id,
      periodStart,
      periodEnd,
      currency,
      status,
      summary,
      actionItems,
      safeToSpendSnapshot,
      model: 'deterministic',
      promptVersion: CFO_BRIEFING_PROMPT_VERSION,
      errorMessage,
    });

    res.status(201).json(serialize(row));
  } catch (e) {
    next(e);
  }
});

router.get('/briefings', async (req, res, next) => {
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
    const rows = await CfoBriefing.findAll({
      where,
      order: [['createdAt', 'DESC']],
      limit,
    });
    res.json({ data: rows.map(serialize) });
  } catch (e) {
    next(e);
  }
});

router.get('/briefings/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const row = await CfoBriefing.findOne({
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
 * Pure-fn that flips a single action item's status. Exported only for
 * unit tests; route mutation handlers use it via {@link mutateItemStatus}.
 *
 * Returns a new array (never mutates input). Invalid status or unknown
 * item id → `{ ok: false }` so callers can map to a 404 response.
 */
export function updateCfoBriefingActionItemStatus(
  items: CfoBriefingActionItem[],
  itemId: string,
  newStatus: CfoBriefingActionItemStatus,
):
  | { ok: true; items: CfoBriefingActionItem[] }
  | { ok: false } {
  if (!CFO_BRIEFING_ACTION_ITEM_STATUSES.includes(newStatus)) return { ok: false };
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
  status: CfoBriefingActionItemStatus,
): Promise<
  | { ok: true; row: CfoBriefing }
  | { ok: false; status: number; error: string }
> {
  const row = await CfoBriefing.findOne({
    where: { id: runId, ...householdWhere(req) },
  });
  if (!row) return { ok: false, status: 404, error: 'Not found' };
  const current = Array.isArray(row.actionItems) ? row.actionItems : [];
  const result = updateCfoBriefingActionItemStatus(current, itemId, status);
  if (!result.ok) {
    return { ok: false, status: 404, error: 'Action item not found' };
  }
  // Sequelize JSON columns need an explicit dirty flag so the new array
  // reference triggers a UPDATE instead of being silently skipped.
  row.actionItems = result.items;
  row.changed('actionItems', true);
  await row.save();
  return { ok: true, row };
}

router.post('/briefings/:id/items/:itemId/resolve', async (req, res, next) => {
  try {
    const runId = Number(req.params.id);
    if (!Number.isInteger(runId) || runId < 1) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const itemId = String(req.params.itemId);
    const out = await mutateItemStatus(req, runId, itemId, 'resolved');
    if (!out.ok) {
      res.status(out.status).json({ error: out.error });
      return;
    }
    res.json(serialize(out.row));
  } catch (e) {
    next(e);
  }
});

router.post('/briefings/:id/items/:itemId/dismiss', async (req, res, next) => {
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
