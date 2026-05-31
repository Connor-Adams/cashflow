import { Router } from 'express';
import { auditAuth } from '../auth/auditAuth';

const router = Router();

router.use(auditAuth);

router.get('/_ping', (_req, res) => {
  res.json({ ok: true });
});

export default router;
