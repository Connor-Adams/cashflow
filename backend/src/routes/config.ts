import { Router } from 'express';
import * as env from '../config/env';

const router = Router();

router.get('/', (_req, res) => {
  res.json({
    logoDevToken: env.logoDevToken,
    quoteProviderConfigured: true,
  });
});

export default router;
