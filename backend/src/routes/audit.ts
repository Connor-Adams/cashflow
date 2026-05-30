import { Router } from 'express';
import { requireAuditAuth } from '../auth/auditAuth';
import { buildHealthDeep } from '../audit/healthDeep';
import { buildFreshness } from '../audit/freshness';
import { buildIntegrity } from '../audit/integrity';
import { buildCounts } from '../audit/counts';
import { buildClientErrors } from '../audit/clientErrors';
import { buildServerErrors } from '../audit/serverErrors';
import { buildRouteProbe } from '../audit/routeProbe';

const router = Router();

router.use(requireAuditAuth);

router.get('/_ping', (_req, res) => {
  res.json({ ok: true });
});

router.get('/health-deep', async (_req, res, next) => {
  try {
    res.json(await buildHealthDeep());
  } catch (e) {
    next(e);
  }
});

router.get('/freshness', async (req, res, next) => {
  try {
    const householdId = req.auditAuth!.household.id;
    res.json(await buildFreshness(householdId));
  } catch (e) {
    next(e);
  }
});

router.get('/integrity', async (req, res, next) => {
  try {
    const householdId = req.auditAuth!.household.id;
    res.json(await buildIntegrity(householdId));
  } catch (e) {
    next(e);
  }
});

router.get('/counts', async (req, res, next) => {
  try {
    const householdId = req.auditAuth!.household.id;
    res.json(await buildCounts(householdId));
  } catch (e) {
    next(e);
  }
});

router.get('/client-errors', async (req, res, next) => {
  try {
    const householdId = req.auditAuth!.household.id;
    const since = req.query.since ? new Date(String(req.query.since)) : undefined;
    const level = req.query.level ? String(req.query.level) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    res.json(await buildClientErrors(householdId, { since, level, limit }));
  } catch (e) { next(e); }
});

router.get('/server-errors', async (req, res, next) => {
  try {
    const householdId = req.auditAuth!.household.id;
    const since = req.query.since ? new Date(String(req.query.since)) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    res.json(await buildServerErrors(householdId, { since, limit }));
  } catch (e) { next(e); }
});

router.get('/route-probe', async (req, res, next) => {
  try {
    const userId = req.auditAuth!.user.id;
    res.json(await buildRouteProbe(req.app, userId));
  } catch (e) { next(e); }
});

export default router;
