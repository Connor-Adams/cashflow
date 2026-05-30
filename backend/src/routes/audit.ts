import { Router } from 'express';
import { requireAuditAuth } from '../auth/auditAuth';
import { healthDeep } from '../audit/healthDeep';

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

export default router;
