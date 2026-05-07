import { Router } from 'express';
import { getOpenAiConfig } from '../config/openai';
import { isDemoUserRequest } from '../demo/aiAccess';

const router = Router();

router.get('/status', (req, res) => {
  res.json({
    openai: !isDemoUserRequest(req) && getOpenAiConfig() != null,
  });
});

export default router;
