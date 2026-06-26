/**
 * GET /api/audit-log — query the finance audit log for the caller's
 * household (Cashflow issue #228).
 *
 * Read-only. Filters:
 *   ?action=transaction.updated      (exact match)
 *   ?entityType=transaction          (exact match)
 *   ?entityId=42                     (exact match — only useful with entityType)
 *   ?actorUserId=7                   (exact match)
 *   ?dateFrom=2026-01-01             (ISO date, inclusive)
 *   ?dateTo=2026-12-31               (ISO date, exclusive upper bound)
 *   ?limit=50                        (default 50, max 200)
 *   ?offset=0                        (default 0)
 *
 * Responses are paginated and ordered by createdAt DESC, id DESC.
 *
 * Rate limit: this list query joins the User table and can be expensive
 * on a long log; CodeQL also flags any authorised route without a rate
 * limiter as high severity, so we apply the shared aiSuggestLimiter
 * (60s window, ~20 req/min default, NODE_ENV=test bypass).
 */

import { Router } from 'express';
import { Op, type WhereOptions } from 'sequelize';
import { AuditLog, User } from '../models';
import { currentAuth } from '../auth/middleware';
import { householdWhere, visibleTransactionWhere } from '../auth/scope';
import { scopeAuditRowsToVisibility } from '../audit/visibility';
import { aiSuggestLimiter } from './aiRateLimit';

const router = Router();

const LIMIT_DEFAULT = 50;
const LIMIT_MAX = 200;
const ENTITY_TYPE_MAX = 64;
const ACTION_MAX = 64;
const ENTITY_ID_MAX = Number.MAX_SAFE_INTEGER;

interface AuditLogQuery {
  action?: string;
  entityType?: string;
  entityId?: number;
  actorUserId?: number;
  dateFrom?: Date;
  dateTo?: Date;
  limit: number;
  offset: number;
}

function parsePositiveInt(value: unknown, max: number): number | null {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0 || n > max) return null;
  return n;
}

function parseIsoDate(value: unknown): Date | null {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(s)) return null;
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return null;
  return d;
}

function parseTokenString(value: unknown, max: number): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (s.length > max) return null;
  // Allow letters, digits, `.`, `_`, `-` — covers `transaction.updated`,
  // `ai_suggestion.accepted`, etc.
  if (!/^[A-Za-z0-9._-]+$/.test(s)) return null;
  return s;
}

function parseQuery(raw: Record<string, unknown>): AuditLogQuery | { error: string } {
  const action = parseTokenString(raw.action, ACTION_MAX);
  if (raw.action != null && raw.action !== '' && !action) {
    return { error: 'action is invalid' };
  }
  const entityType = parseTokenString(raw.entityType, ENTITY_TYPE_MAX);
  if (raw.entityType != null && raw.entityType !== '' && !entityType) {
    return { error: 'entityType is invalid' };
  }
  const entityId = parsePositiveInt(raw.entityId, ENTITY_ID_MAX);
  if (raw.entityId != null && raw.entityId !== '' && entityId == null) {
    return { error: 'entityId must be a non-negative integer' };
  }
  const actorUserId = parsePositiveInt(raw.actorUserId, ENTITY_ID_MAX);
  if (raw.actorUserId != null && raw.actorUserId !== '' && actorUserId == null) {
    return { error: 'actorUserId must be a non-negative integer' };
  }
  const dateFrom = parseIsoDate(raw.dateFrom);
  if (raw.dateFrom != null && raw.dateFrom !== '' && !dateFrom) {
    return { error: 'dateFrom must be ISO 8601 (YYYY-MM-DD)' };
  }
  const dateTo = parseIsoDate(raw.dateTo);
  if (raw.dateTo != null && raw.dateTo !== '' && !dateTo) {
    return { error: 'dateTo must be ISO 8601 (YYYY-MM-DD)' };
  }
  if (dateFrom && dateTo && dateFrom > dateTo) {
    return { error: 'dateFrom must be on or before dateTo' };
  }
  const limitRaw = parsePositiveInt(raw.limit, LIMIT_MAX);
  const limit =
    limitRaw == null || limitRaw === 0 ? LIMIT_DEFAULT : Math.min(limitRaw, LIMIT_MAX);
  const offsetRaw = parsePositiveInt(raw.offset, Number.MAX_SAFE_INTEGER);
  const offset = offsetRaw == null ? 0 : offsetRaw;

  return {
    action: action ?? undefined,
    entityType: entityType ?? undefined,
    entityId: entityId ?? undefined,
    actorUserId: actorUserId ?? undefined,
    dateFrom: dateFrom ?? undefined,
    dateTo: dateTo ?? undefined,
    limit,
    offset,
  };
}

function serialize(
  row: AuditLog,
  actorNames: Map<number, { displayName: string | null; email: string | null }>,
) {
  const actor = row.actorUserId != null ? actorNames.get(row.actorUserId) ?? null : null;
  return {
    id: row.id,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    actorUserId: row.actorUserId,
    actorDisplayName: actor?.displayName ?? null,
    actorEmail: actor?.email ?? null,
    summary: row.summary,
    before: row.before ?? null,
    after: row.after ?? null,
    metadata: row.metadata ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

async function fetchActorNames(
  ids: number[],
): Promise<Map<number, { displayName: string | null; email: string | null }>> {
  const map = new Map<
    number,
    { displayName: string | null; email: string | null }
  >();
  if (ids.length === 0) return map;
  const users = await User.findAll({
    where: { id: { [Op.in]: ids } },
    attributes: ['id', 'displayName', 'email'],
  });
  for (const u of users) {
    map.set(u.id, { displayName: u.displayName ?? null, email: u.email ?? null });
  }
  return map;
}

router.get('/', aiSuggestLimiter, async (req, res, next) => {
  try {
    const parsed = parseQuery(req.query as Record<string, unknown>);
    if ('error' in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const where: WhereOptions = { ...householdWhere(req) };
    if (parsed.action) (where as Record<string, unknown>).action = parsed.action;
    if (parsed.entityType)
      (where as Record<string, unknown>).entityType = parsed.entityType;
    if (parsed.entityId != null)
      (where as Record<string, unknown>).entityId = parsed.entityId;
    if (parsed.actorUserId != null)
      (where as Record<string, unknown>).actorUserId = parsed.actorUserId;
    if (parsed.dateFrom || parsed.dateTo) {
      const createdAt: Record<symbol, unknown> = {};
      if (parsed.dateFrom) createdAt[Op.gte] = parsed.dateFrom;
      if (parsed.dateTo) createdAt[Op.lt] = parsed.dateTo;
      (where as Record<string, unknown>).createdAt = createdAt;
    }

    const { count, rows } = await AuditLog.findAndCountAll({
      where,
      order: [
        ['createdAt', 'DESC'],
        ['id', 'DESC'],
      ],
      limit: parsed.limit,
      offset: parsed.offset,
    });

    // Re-apply row-level visibility: drop snapshots for private rows the
    // caller may not see (#838). Filtering happens on the fetched page; the
    // household `total` is an upper bound on what may be visible.
    const visibleRows = await scopeAuditRowsToVisibility(req, rows);
    const hiddenOnPage = rows.length - visibleRows.length;

    const actorIds = Array.from(
      new Set(
        visibleRows
          .map((r) => r.actorUserId)
          .filter((id): id is number => id != null),
      ),
    );
    const actorNames = await fetchActorNames(actorIds);

    res.json({
      total: Math.max(0, count - hiddenOnPage),
      limit: parsed.limit,
      offset: parsed.offset,
      items: visibleRows.map((r) => serialize(r, actorNames)),
    });
  } catch (e) {
    next(e);
  }
});

/**
 * Convenience endpoint: history of audit rows for a single transaction.
 * Used by the transaction detail view to render "<actor> changed
 * category on <date>" entries inline.
 */
router.get('/transactions/:id', aiSuggestLimiter, async (req, res, next) => {
  try {
    const id = parsePositiveInt(req.params.id, ENTITY_ID_MAX);
    if (id == null) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    // Ensure the transaction is VISIBLE to the caller before returning its
    // audit history: a member must not read a private (non-owned) row's
    // before/after snapshots through the audit log (#838). Using
    // `visibleTransactionWhere` (not plain `householdWhere`) makes a private,
    // not-yours transaction 404 here exactly as it would in normal queries.
    const { Transaction } = await import('../models');
    const txn = await Transaction.findOne({
      where: { id, ...visibleTransactionWhere(req) },
      attributes: ['id'],
    });
    if (!txn) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    void currentAuth(req); // ensure auth still valid
    const rows = await AuditLog.findAll({
      where: {
        ...householdWhere(req),
        entityType: 'transaction',
        entityId: id,
      },
      order: [
        ['createdAt', 'DESC'],
        ['id', 'DESC'],
      ],
      limit: LIMIT_MAX,
    });
    const actorIds = Array.from(
      new Set(
        rows
          .map((r) => r.actorUserId)
          .filter((aid): aid is number => aid != null),
      ),
    );
    const actorNames = await fetchActorNames(actorIds);
    res.json({ items: rows.map((r) => serialize(r, actorNames)) });
  } catch (e) {
    next(e);
  }
});

/**
 * Convenience endpoint: history of audit rows for a single rule.
 */
router.get('/rules/:id', aiSuggestLimiter, async (req, res, next) => {
  try {
    const id = parsePositiveInt(req.params.id, ENTITY_ID_MAX);
    if (id == null) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const { Rule } = await import('../models');
    const rule = await Rule.findOne({
      where: { id, ...householdWhere(req) },
      attributes: ['id'],
    });
    if (!rule) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    void currentAuth(req);
    const rows = await AuditLog.findAll({
      where: {
        ...householdWhere(req),
        entityType: 'rule',
        entityId: id,
      },
      order: [
        ['createdAt', 'DESC'],
        ['id', 'DESC'],
      ],
      limit: LIMIT_MAX,
    });
    const actorIds = Array.from(
      new Set(
        rows
          .map((r) => r.actorUserId)
          .filter((aid): aid is number => aid != null),
      ),
    );
    const actorNames = await fetchActorNames(actorIds);
    res.json({ items: rows.map((r) => serialize(r, actorNames)) });
  } catch (e) {
    next(e);
  }
});

export default router;
