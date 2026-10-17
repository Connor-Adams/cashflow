import { Router, type Request } from 'express';
import { aggregateDataQuality } from '../summary/dataQuality';
import { DATA_QUALITY_ACTION_LINKS } from '../summary/dataQualityScore';
import { checkBalanceIntegrity } from '../networth/balanceReconciliation';
import {
  householdWhere,
  visibleAccountWhere,
  visibleStatementWhere,
  visibleTransactionWhere,
} from '../auth/scope';

const router = Router();

function balanceIntegrityFor(req: Request) {
  return checkBalanceIntegrity({
    accountScope: visibleAccountWhere(req),
    statementScope: visibleStatementWhere(req),
  });
}

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
 *   - balanceIntegrity: statement-vs-computed balance mismatches and accounts
 *     with an undated opening balance (networth/balanceReconciliation.ts).
 *     Reported alongside the score, not folded into it — it is a list of
 *     concrete defects to fix, not a coverage ratio.
 *
 * Transactions are scoped via visibleTransactionWhere (shared OR
 * createdByUserId) — non-superadmin users only see their own dataset's
 * quality, never another household's. Subscriptions use householdWhere
 * (no per-user visibility — subscriptions are household-shared by design).
 */
router.get('/', async (req, res, next) => {
  try {
    const [result, balanceIntegrity] = await Promise.all([
      aggregateDataQuality({
        transactionScope: visibleTransactionWhere(req),
        subscriptionScope: householdWhere(req),
      }),
      balanceIntegrityFor(req),
    ]);
    res.json({
      ...result,
      balanceIntegrity,
      actionLinks: DATA_QUALITY_ACTION_LINKS,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/data-quality/balances
 *
 * Just the balance-integrity section of the data-quality report, for the
 * net-worth page, which shows these warnings beside the balances they affect
 * and has no use for the full transaction scan behind the score.
 */
router.get('/balances', async (req, res, next) => {
  try {
    res.json(await balanceIntegrityFor(req));
  } catch (e) {
    next(e);
  }
});

export default router;
