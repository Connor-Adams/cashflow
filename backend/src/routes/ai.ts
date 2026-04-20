import { Router } from 'express';
import { getOpenAiConfig } from '../config/openai';

const router = Router();

router.get('/status', (_req, res) => {
  res.json({
    openai: getOpenAiConfig() != null,
  });
});

export default router;
