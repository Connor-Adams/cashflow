import { Router } from 'express';
import type { Application } from 'express';
import { requireAuditAuth } from '../auth/auditAuth';
import { getIntegrity } from '../audit/integrity';
import { getCounts } from '../audit/counts';
import { getClientErrors } from '../audit/clientErrors';
import { getServerErrors } from '../audit/serverErrors';
import { runRouteProbe } from '../audit/routeProbe';
import { getAuditSummary } from '../audit/summary';

// The app instance is injected at mount time for the route-probe feature.
// Default to undefined; callers that need route-probe must call injectApp().
let _app: Application | undefined;
export function injectApp(app: Application): void {
  _app = app;
}

const router = Router();

router.use(requireAuditAuth);

router.get('/_ping', (_req, res) => {
  res.json({ ok: true });
});

// #390 — integrity probe
router.get('/integrity', async (req, res, next) => {
  try {
    const householdId = req.auditAuth!.household.id;
    const result = await getIntegrity(householdId);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

// #391 — per-model row counts
router.get('/counts', async (req, res, next) => {
  try {
    const householdId = req.auditAuth!.household.id;
    const result = await getCounts(householdId);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

// #392 — client-error ring buffer
router.get('/client-errors', async (req, res, next) => {
  try {
    const householdId = req.auditAuth!.household.id;
    const since = typeof req.query.since === 'string' ? req.query.since : undefined;
    const level = typeof req.query.level === 'string' ? req.query.level : undefined;
    const limit = req.query.limit != null ? Number(req.query.limit) : undefined;
    const result = await getClientErrors(householdId, { since, level, limit });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

// #393 — server-error ring buffer
router.get('/server-errors', async (req, res, next) => {
  try {
    const householdId = req.auditAuth!.household.id;
    const since = typeof req.query.since === 'string' ? req.query.since : undefined;
    const limit = req.query.limit != null ? Number(req.query.limit) : undefined;
    const result = await getServerErrors(householdId, { since, limit });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

// #394 — route probe via ephemeral session
router.get('/route-probe', async (req, res, next) => {
  try {
    if (!_app) {
      res.status(503).json({ error: 'Route probe not available (app not injected)' });
      return;
    }
    const result = await runRouteProbe(_app, req.auditAuth!);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

// #395 — composite summary
router.get('/summary', async (req, res, next) => {
  try {
    if (!_app) {
      res.status(503).json({ error: 'Summary not available (app not injected)' });
      return;
    }
    const householdId = req.auditAuth!.household.id;
    const windowMinutes = req.query.windowMinutes != null ? Number(req.query.windowMinutes) : 60;
    const result = await getAuditSummary(householdId, req.auditAuth!, _app, windowMinutes);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

export default router;
