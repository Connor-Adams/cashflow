import { Router } from 'express';
import { requireAuditAuth } from '../auth/auditAuth';
import { counts } from '../audit/counts';
import { healthDeep } from '../audit/healthDeep';
import { freshness } from '../audit/freshness';
import { integrity } from '../audit/integrity';

const router = Router();

router.use(requireAuditAuth);

router.get('/_ping', (_req, res) => {
  res.json({ ok: true });
});

router.get('/health-deep', async (_req, res, next) => {
  try {
    const result = await healthDeep();
    res.json(result);
  } catch (e) {
    next(e);
  }
});

router.get('/freshness', async (req, res, next) => {
  try {
    const { household } = req.auditAuth!;
    res.json(await freshness(household.id));
  } catch (e) {
    next(e);
  }
});

router.get('/integrity', async (req, res, next) => {
  try {
    const { household } = req.auditAuth!;
    res.json(await integrity(household.id));
  } catch (e) {
    next(e);
  }
});

router.get('/counts', async (req, res, next) => {
  try {
    const { household } = req.auditAuth!;
    res.json(await counts(household.id));
  } catch (e) {
    next(e);
  }
});

export default router;
