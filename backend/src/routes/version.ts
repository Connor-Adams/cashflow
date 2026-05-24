import { Router } from 'express';

const router = Router();

router.get('/', (_req, res) => {
  res.json({
    version: process.env.APP_VERSION ?? 'dev',
  });
});

export default router;
