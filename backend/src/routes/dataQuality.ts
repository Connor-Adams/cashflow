import { Router } from 'express';
import { aggregateDataQuality } from '../summary/dataQuality';
import { DATA_QUALITY_ACTION_LINKS } from '../summary/dataQualityScore';
import { householdWhere, visibleTransactionWhere } from '../auth/scope';

const router = Router();

/**
 * GET /api/data-quality
 *
 * Data-quality dashboard score for the active household (#234). Returns:
 *   - score: overall 0..1 quality, equally-weighted mean of the seven
 *     component scores.
 *   - componentScores: each component's 0..1 normalized score.
 *   - components: raw counts/totals per component for the UI cards.
 *   - actionLinks: per-component label + href so the frontend can render
 *     "click to fix" links without baking the routes into JSX.
 *   - totals: convenience top-level scan counters.
 *
 * Transactions are scoped via visibleTransactionWhere (shared OR
 * createdByUserId) — non-superadmin users only see their own dataset's
 * quality, never another household's. Subscriptions use householdWhere
 * (no per-user visibility — subscriptions are household-shared by design).
 */
router.get('/', async (req, res, next) => {
  try {
    const result = await aggregateDataQuality({
      transactionScope: visibleTransactionWhere(req),
      subscriptionScope: householdWhere(req),
    });
    res.json({
      ...result,
      actionLinks: DATA_QUALITY_ACTION_LINKS,
    });
  } catch (e) {
    next(e);
  }
});

export default router;
