// backend/src/routes/tax-personal-scenarios.ts
//
// DEPRECATED (issue #377): replaced by /api/tax/scenarios?kind=personal.
// All requests return 410 Gone with a redirect hint.
import { Router } from 'express';

const router = Router();
router.all('*', (_req, res) => {
  res.status(410).json({ error: 'gone', redirect: '/api/tax/scenarios?kind=personal' });
});
export default router;
