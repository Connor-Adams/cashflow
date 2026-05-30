/**
 * POST /api/opportunity-cost/calculate — the opportunity-cost calculator
 * (issue #252).
 *
 * Answers "what if I invested this instead of spending it?" by projecting the
 * future value of a one-time or recurring amount at an assumed return rate over
 * a chosen horizon. Requires auth (so it's gated like the rest of /api) but
 * performs NO persistence — calculating an opportunity cost never reads or
 * writes any transaction, so it cannot alter transaction totals (AC).
 */
import { Router } from 'express';
import { currentAuth } from '../auth/middleware';
import {
  computeOpportunityCost,
  validateOpportunityCostInput,
} from '../cashflow/opportunityCost';

const router = Router();

router.post('/calculate', (req, res, next) => {
  try {
    // Require authentication (throws 401 if absent). The identity isn't used
    // beyond gating — the calculation is stateless.
    currentAuth(req);

    const parsed = validateOpportunityCostInput(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    const result = computeOpportunityCost(parsed.value);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
