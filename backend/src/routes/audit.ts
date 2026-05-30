import { Router } from 'express';
import { requireAuditAuth } from '../auth/auditAuth';
import { buildHealthDeep } from '../audit/healthDeep';
import { buildCounts } from '../audit/counts';
import { buildFreshness } from '../audit/freshness';
import { buildIntegrity } from '../audit/integrity';
import { buildClientErrors } from '../audit/clientErrors';
import { buildServerErrors } from '../audit/serverErrors';
import { buildRouteProbe } from '../audit/routeProbe';
import { buildAuditSummary } from '../audit/summary';

const router = Router();

router.use(requireAuditAuth);

router.get('/_ping', (_req, res) => {
  res.json({ ok: true });
});

router.get('/health-deep', async (_req, res, next) => {
  try {
    const result = await buildHealthDeep();
    res.json(result);
  } catch (e) {
    next(e);
  }
});

router.get('/counts', async (req, res, next) => {
  try {
    const householdId = req.auditAuth!.household.id;
    const counts = await buildCounts(householdId);
    res.json({ counts, generatedAt: new Date().toISOString() });
  } catch (e) {
    next(e);
  }
});

router.get('/integrity', async (req, res, next) => {
  try {
    const householdId = req.auditAuth!.household.id;
    const result = await buildIntegrity(householdId);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

router.get('/freshness', async (req, res, next) => {
  try {
    const householdId = req.auditAuth!.household.id;
    const result = await buildFreshness(householdId);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

router.get('/summary', async (req, res, next) => {
  try {
    const { user, household } = req.auditAuth!;
    const localPort = (req.socket as { localPort?: number }).localPort ?? 3001;
    const rawWindow = parseInt(String(req.query.windowMinutes ?? '60'), 10);
    const windowMinutes = Math.min(Math.max(1, Number.isFinite(rawWindow) ? rawWindow : 60), 1440);
    const result = await buildAuditSummary(user, household, localPort, windowMinutes);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

router.get('/route-probe', async (req, res, next) => {
  try {
    const { user } = req.auditAuth!;
    const localPort = (req.socket as { localPort?: number }).localPort ?? 3001;
    const result = await buildRouteProbe(user, localPort);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

router.get('/client-errors', async (req, res, next) => {
  try {
    const householdId = req.auditAuth!.household.id;
    const since = req.query.since as string | undefined;
    const level = req.query.level as string | undefined;
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : undefined;
    const result = await buildClientErrors(householdId, { since, level, limit });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

router.get('/server-errors', async (req, res, next) => {
  try {
    const householdId = req.auditAuth!.household.id;
    const since = req.query.since as string | undefined;
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : undefined;
    const result = await buildServerErrors(householdId, { since, limit });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

export default router;
