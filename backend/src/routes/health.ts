import { Router } from 'express';

const router = Router();

router.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'cashflow-backend',
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

export default router;
