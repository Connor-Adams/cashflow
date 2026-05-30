/**
 * GET /api/finance-events — read the finance domain event stream for
 * the caller's household (Cashflow issue #238).
 *
 * Read-only. Filters:
 *   ?type=transaction.updated   (exact match)
 *   ?entityType=transaction     (exact match)
 *   ?entityId=42                (exact match; useful with entityType)
 *   ?actorUserId=7              (exact match)
 *   ?dateFrom=2026-01-01        (ISO date, inclusive — on createdAt)
 *   ?dateTo=2026-12-31          (ISO date, exclusive upper bound)
 *   ?limit=50                   (default 50, max 200)
 *   ?offset=0                   (default 0)
 *   ?order=asc|desc             (default desc — newest first)
 *
 * Responses are paginated and ordered by createdAt, id (asc/desc).
 *
 * Rate limit: shared aiSuggestLimiter (60s window, ~20 req/min default,
 * NODE_ENV=test bypass) — required for any list query that hits the
 * DB on a per-request basis.
 *
 * Convenience: /api/finance-events/entity/:entityType/:entityId returns
 * the full event history for one entity (ASC, replay order) — used by
 * future projections and the agent context.
 */

import { Router } from 'express';
import { Op, type WhereOptions } from 'sequelize';
import { FinanceEvent } from '../models';
import { householdWhere } from '../auth/scope';
import { aiSuggestLimiter } from './aiRateLimit';

const router = Router();

const LIMIT_DEFAULT = 50;
const LIMIT_MAX = 200;
const TYPE_MAX = 64;
const ENTITY_TYPE_MAX = 64;
const ENTITY_ID_MAX = Number.MAX_SAFE_INTEGER;

interface FinanceEventsQuery {
  type?: string;
  entityType?: string;
  entityId?: number;
  actorUserId?: number;
  dateFrom?: Date;
  dateTo?: Date;
  limit: number;
  offset: number;
  order: 'asc' | 'desc';
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
  if (!/^[A-Za-z0-9._-]+$/.test(s)) return null;
  return s;
}

function parseQuery(
  raw: Record<string, unknown>,
): FinanceEventsQuery | { error: string } {
  const type = parseTokenString(raw.type, TYPE_MAX);
  if (raw.type != null && raw.type !== '' && !type) {
    return { error: 'type is invalid' };
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

  let order: 'asc' | 'desc' = 'desc';
  if (typeof raw.order === 'string') {
    const o = raw.order.toLowerCase();
    if (o === 'asc') order = 'asc';
    else if (o === 'desc') order = 'desc';
    else return { error: 'order must be "asc" or "desc"' };
  }

  return {
    type: type ?? undefined,
    entityType: entityType ?? undefined,
    entityId: entityId ?? undefined,
    actorUserId: actorUserId ?? undefined,
    dateFrom: dateFrom ?? undefined,
    dateTo: dateTo ?? undefined,
    limit,
    offset,
    order,
  };
}

function serialize(row: FinanceEvent) {
  return {
    id: row.id,
    type: row.type,
    entityType: row.entityType,
    entityId: row.entityId,
    actorUserId: row.actorUserId,
    payload: row.payload ?? null,
    occurredAt: row.occurredAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

router.get('/', aiSuggestLimiter, async (req, res, next) => {
  try {
    const parsed = parseQuery(req.query as Record<string, unknown>);
    if ('error' in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const where: WhereOptions = { ...householdWhere(req) };
    if (parsed.type) (where as Record<string, unknown>).type = parsed.type;
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

    const dir = parsed.order === 'asc' ? 'ASC' : 'DESC';
    const { count, rows } = await FinanceEvent.findAndCountAll({
      where,
      order: [
        ['createdAt', dir],
        ['id', dir],
      ],
      limit: parsed.limit,
      offset: parsed.offset,
    });

    res.json({
      total: count,
      limit: parsed.limit,
      offset: parsed.offset,
      items: rows.map(serialize),
    });
  } catch (e) {
    next(e);
  }
});

/**
 * Convenience: full event stream for one entity in replay order
 * (createdAt ASC). Used by projections / undo handlers / agent context.
 *
 * Empty list (not 404) when the entity has no events. Distinguishing
 * "no events" from "no access" would require N extra queries per
 * entity type; the household scope already prevents cross-household
 * reads.
 */
router.get(
  '/entity/:entityType/:entityId',
  aiSuggestLimiter,
  async (req, res, next) => {
    try {
      const entityType = parseTokenString(req.params.entityType, ENTITY_TYPE_MAX);
      const entityId = parsePositiveInt(req.params.entityId, ENTITY_ID_MAX);
      if (!entityType) {
        res.status(400).json({ error: 'Invalid entityType' });
        return;
      }
      if (entityId == null) {
        res.status(400).json({ error: 'Invalid entityId' });
        return;
      }

      const rows = await FinanceEvent.findAll({
        where: {
          ...householdWhere(req),
          entityType,
          entityId,
        },
        order: [
          ['createdAt', 'ASC'],
          ['id', 'ASC'],
        ],
        limit: LIMIT_MAX,
      });

      res.json({ items: rows.map(serialize) });
    } catch (e) {
      next(e);
    }
  },
);

export default router;
