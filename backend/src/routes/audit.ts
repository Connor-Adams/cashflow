import { Router } from 'express';
import { requireAuditAuth } from '../auth/auditAuth';
import { buildHealthDeep } from '../audit/healthDeep';
import { buildFreshness } from '../audit/freshness';
import { buildIntegrity } from '../audit/integrity';
import { buildCounts } from '../audit/counts';

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

export default router;
