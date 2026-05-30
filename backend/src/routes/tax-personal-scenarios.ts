// backend/src/routes/tax-personal-scenarios.ts
//
// DEPRECATED — all personal tax scenario endpoints have moved to
// /api/tax/scenarios?kind=personal (see tax-scenarios.ts).
//
// This router returns 410 Gone for every path so that stale bookmarks /
// cached API clients fail fast with a clear migration message.
import { Router } from 'express';

const router = Router();

router.all('*', (_req, res) => {
  res.status(410).json({
    error: 'gone',
    message: 'Use /api/tax/scenarios?kind=personal',
  });
});

export default router;
