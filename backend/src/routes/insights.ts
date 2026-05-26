/**
 * /api/insights — deterministic insight inbox.
 *
 * - GET    /          list insights (optionally filtered by status / severity)
 * - POST   /run       run all detectors against the caller's household, upsert
 *                     rows, return summary
 * - PATCH  /:id       update a single insight's status (dismiss / resolve /
 *                     reopen)
 *
 * Future #210 AI review consumes this exact table; the schema is a contract.
 */
import { Router } from 'express';
import {
  Insight,
  type InsightSeverity,
  INSIGHT_STATUSES,
  type InsightStatus,
} from '../models/Insight';
import { currentAuth } from '../auth/middleware';
import { householdWhere } from '../auth/scope';
import { runDetectorsForHousehold } from '../insights/runDetectors';

const router = Router();

type InsightResponse = {
  id: number;
  type: string;
  severity: InsightSeverity;
  title: string;
  description: string | null;
  entityType: string | null;
  entityId: number | null;
  status: InsightStatus;
  metadata: unknown;
  detectedAt: string;
  createdAt: string;
  updatedAt: string;
};

function serialize(row: InstanceType<typeof Insight>): InsightResponse {
  return {
    id: row.id,
    type: row.type,
    severity: row.severity,
    title: row.title,
    description: row.description,
    entityType: row.entityType,
    entityId: row.entityId,
    status: row.status,
    metadata: row.metadata,
    detectedAt: row.detectedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const SEVERITY_RANK: Record<InsightSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

router.get('/', async (req, res, next) => {
  try {
    const where: Record<string, unknown> = { ...householdWhere(req) };
    const statusParam = req.query.status;
    if (typeof statusParam === 'string') {
      if (!(INSIGHT_STATUSES as readonly string[]).includes(statusParam)) {
        res.status(400).json({ error: `status must be one of: ${INSIGHT_STATUSES.join(', ')}` });
        return;
      }
      where.status = statusParam;
    }

    const rows = await Insight.findAll({ where });
    rows.sort((a, b) => {
      const diff =
        SEVERITY_RANK[a.severity as InsightSeverity] -
        SEVERITY_RANK[b.severity as InsightSeverity];
      if (diff !== 0) return diff;
      return b.detectedAt.getTime() - a.detectedAt.getTime();
    });
    res.json({ data: rows.map(serialize) });
  } catch (e) {
    next(e);
  }
});

router.post('/run', async (req, res, next) => {
  try {
    const { household, user } = currentAuth(req);
    const result = await runDetectorsForHousehold(household.id, { userId: user.id });
    res.status(200).json(result);
  } catch (e) {
    next(e);
  }
});

type PatchInsightBody = { status?: unknown };

router.patch('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const row = await Insight.findOne({ where: { id, ...householdWhere(req) } });
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const body = (req.body ?? {}) as PatchInsightBody;
    if (body.status !== undefined) {
      const status = String(body.status);
      if (!(INSIGHT_STATUSES as readonly string[]).includes(status)) {
        res.status(400).json({ error: `status must be one of: ${INSIGHT_STATUSES.join(', ')}` });
        return;
      }
      row.set('status', status as InsightStatus);
    }
    await row.save();
    res.json(serialize(row));
  } catch (e) {
    next(e);
  }
});

export default router;
