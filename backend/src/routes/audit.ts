import { Router } from 'express';
import { requireAuditAuth } from '../auth/auditAuth';
import { runHealthDeep } from '../audit/healthDeep';
import { runFreshness } from '../audit/freshness';
import { runCounts } from '../audit/counts';

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

export default router;
