import { Router } from 'express';

const router = Router();

router.get('/items', async (_req, res, next) => {
  try {
    res.json({ items: [], nextCursor: null });
  } catch (e) {
    next(e);
  }
});

export default router;
