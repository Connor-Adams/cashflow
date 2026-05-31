import { Router } from 'express';
import { requireAuditAuth } from '../auth/auditAuth';

const router = Router();

router.use(requireAuditAuth);

router.get('/_ping', (_req, res) => {
  res.json({ ok: true });
});

export default router;
