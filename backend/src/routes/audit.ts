import { Router } from 'express';
import { requireAuditAuth } from '../auth/auditAuth';
import { buildHealthDeep } from '../audit/healthDeep';
import { buildCounts } from '../audit/counts';

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

export default router;
