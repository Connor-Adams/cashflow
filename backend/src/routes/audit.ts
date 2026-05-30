import { Router } from 'express';
import { requireAuditAuth } from '../auth/auditAuth';
import { healthDeep } from '../audit/healthDeep';
import { freshness } from '../audit/freshness';
import { integrity } from '../audit/integrity';
import { counts } from '../audit/counts';
import { clientErrors } from '../audit/clientErrors';
import { serverErrors } from '../audit/serverErrors';

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
    const since = req.query.since ? new Date(String(req.query.since)) : null;
    const limit = req.query.limit ? Number(req.query.limit) : 100;
    const level = req.query.level ? String(req.query.level) : null;
    res.json(await clientErrors(req.auditAuth!.household.id, { since, limit, level }));
  } catch (e) {
    next(e);
  }
});

router.get('/server-errors', async (req, res, next) => {
  try {
    const since = req.query.since ? new Date(String(req.query.since)) : null;
    const limit = req.query.limit ? Number(req.query.limit) : 100;
    const status = req.query.status ? Number(req.query.status) : null;
    res.json(await serverErrors(req.auditAuth!.household.id, { since, limit, status }));
  } catch (e) {
    next(e);
  }
});

export default router;
