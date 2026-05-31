import { Router } from 'express';
import { requireAuditAuth } from '../auth/auditAuth';
import { healthDeep } from '../audit/healthDeep';
import { freshness } from '../audit/freshness';
import { integrity } from '../audit/integrity';
import { counts } from '../audit/counts';
import { queryClientErrors } from '../audit/clientErrors';
import { queryServerErrors } from '../audit/serverErrors';
import { routeProbe } from '../audit/routeProbe';
import { buildSummary } from '../audit/summary';
import * as env from '../config/env';

const router = Router();

router.use(requireAuditAuth);

router.get('/_ping', (_req, res) => {
  res.json({ ok: true });
});

router.get('/health-deep', async (_req, res, next) => {
  try {
    res.json(await healthDeep());
  } catch (e) {
    next(e);
  }
});

router.get('/freshness', async (req, res, next) => {
  try {
    res.json(await freshness(req.auditAuth!.household.id));
  } catch (e) {
    next(e);
  }
});

router.get('/integrity', async (req, res, next) => {
  try {
    res.json(await integrity(req.auditAuth!.household.id));
  } catch (e) {
    next(e);
  }
});

router.get('/counts', async (req, res, next) => {
  try {
    res.json(await counts(req.auditAuth!.household.id));
  } catch (e) {
    next(e);
  }
});

router.get('/client-errors', async (req, res, next) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    res.json(
      await queryClientErrors({
        householdId: req.auditAuth!.household.id,
        since: q.since,
        level: q.level,
        limit: q.limit != null ? Number(q.limit) : undefined,
      }),
    );
  } catch (e) {
    next(e);
  }
});

router.get('/server-errors', async (req, res, next) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    res.json(
      await queryServerErrors({
        householdId: req.auditAuth!.household.id,
        since: q.since,
        limit: q.limit != null ? Number(q.limit) : undefined,
      }),
    );
  } catch (e) {
    next(e);
  }
});

router.get('/route-probe', async (req, res, next) => {
  try {
    const baseUrl = `http://localhost:${env.port}`;
    const sessionCookie = req.headers.cookie ?? '';
    res.json(await routeProbe({ baseUrl, sessionCookie }));
  } catch (e) {
    next(e);
  }
});

router.get('/summary', async (req, res, next) => {
  try {
    res.json(await buildSummary(req.auditAuth!.household.id));
  } catch (e) {
    next(e);
  }
});

export default router;
