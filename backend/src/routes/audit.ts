import { Router } from 'express';
import { requireAuditAuth } from '../auth/auditAuth';
import { runHealthDeep } from '../audit/healthDeep';
import { runFreshness } from '../audit/freshness';
import { runCounts } from '../audit/counts';
import { runIntegrity } from '../audit/integrity';
import { runClientErrors } from '../audit/clientErrors';
import { runServerErrors } from '../audit/serverErrors';
import { runRouteProbe } from '../audit/routeProbe';

const router = Router();

router.use(requireAuditAuth);

router.get('/_ping', (_req, res) => {
  res.json({ ok: true });
});

router.get('/health-deep', async (_req, res, next) => {
  try {
    const result = await runHealthDeep();
    res.json(result);
  } catch (e) {
    next(e);
  }
});

router.get('/freshness', async (req, res, next) => {
  try {
    const { household } = req.auditAuth!;
    const result = await runFreshness(household.id);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

router.get('/counts', async (req, res, next) => {
  try {
    const { household } = req.auditAuth!;
    const result = await runCounts(household.id);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

router.get('/integrity', async (req, res, next) => {
  try {
    const { household } = req.auditAuth!;
    const result = await runIntegrity(household.id);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

router.get('/client-errors', async (req, res, next) => {
  try {
    const { household } = req.auditAuth!;
    const since = typeof req.query.since === 'string' ? req.query.since : undefined;
    const level = typeof req.query.level === 'string' ? req.query.level : undefined;
    const limitRaw = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : undefined;
    const result = await runClientErrors(household.id, { since, level, limit: limitRaw });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

router.get('/server-errors', async (req, res, next) => {
  try {
    const { household } = req.auditAuth!;
    const since = typeof req.query.since === 'string' ? req.query.since : undefined;
    const limitRaw = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : undefined;
    const result = await runServerErrors(household.id, { since, limit: limitRaw });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

router.get('/route-probe', async (req, res, next) => {
  try {
    const { user } = req.auditAuth!;
    const result = await runRouteProbe(user.id);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

export default router;
