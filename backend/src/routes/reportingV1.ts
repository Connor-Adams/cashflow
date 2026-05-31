/**
 * GET-only reporting API (issue #429–430). All routes require a cfr_ bearer
 * token and are household-scoped via req.reportingAuth.
 *
 * v1 contract: all money values are numbers (not strings), currency is the
 * household's default unless overridden by ?currency=. Dates are YYYY-MM-DD.
 */
import { Router } from 'express';
import { Op } from 'sequelize';
import { Account, Transaction } from '../models';
import {
  aggregateDashboard,
  type AccountRow,
  type SummaryTxnRow,
} from '../summary/aggregateDashboard';
import { loadItemAllocationContext } from '../summary/loadItemAllocations';
import { buildNetWorthAt } from '../networth/aggregate';
import { computeSafeToSpend } from '../cashflow/safeToSpend';

const router = Router();

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 30 days ago (used as default reporting window for spend metrics). */
function thirtyDaysAgo(): string {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString().slice(0, 10);
}

/**
 * GET /api/v1/summary
 *
 * Returns headline financial numbers: current net worth, 30-day spend/income,
 * safe-to-spend, and a currency. Mirrors the numbers on the dashboard.
 */
router.get('/summary', async (req, res, next) => {
  try {
    const { user, household } = req.reportingAuth!;
    const currency =
      typeof req.query.currency === 'string' && /^[A-Z]{3}$/.test(req.query.currency)
        ? req.query.currency
        : null;

    const today = todayIso();
    const windowStart = thirtyDaysAgo();

    // Accounts visible to this household.
    const accounts = await Account.findAll({
      where: { householdId: household.id, closedAt: { [Op.or]: [null, { [Op.gt]: today }] } },
      attributes: ['id', 'name', 'shortCode', 'accountType', 'defaultCurrency'],
      raw: true,
    });
    const accountIds = accounts.map((a) => (a as unknown as { id: number }).id);

    // Net worth today.
    const nw = await buildNetWorthAt(today, accountIds);

    // 30-day spend/income aggregation.
    const txns = await Transaction.findAll({
      where: {
        householdId: household.id,
        date: { [Op.between]: [windowStart, today] },
      },
      attributes: [
        'id', 'accountId', 'date', 'currency', 'finalCategory', 'finalBusiness',
        'finalSplitType', 'merchantRaw', 'merchantClean', 'merchantCanonical',
        'amount', 'businessAmount', 'reviewFlag', 'txnType', 'linkedTransactionId',
      ],
      raw: true,
    });
    const accountById = new Map<number, AccountRow>(
      (accounts as unknown as AccountRow[]).map((a) => [
        (a as unknown as { id: number }).id,
        a as unknown as AccountRow,
      ]),
    );
    const itemCtx = await loadItemAllocationContext(
      txns.map((r) => (r as unknown as SummaryTxnRow).id),
    );
    const agg = aggregateDashboard(txns as unknown as SummaryTxnRow[], accountById, itemCtx);

    // Pick the primary currency bucket — prefer explicit ?currency, else CAD.
    const targetCcy = currency ?? 'CAD';
    const metrics = agg.metricsByCurrency.get(targetCcy) ?? {
      currency: targetCcy,
      totalSpend: 0,
      totalCredits: 0,
      totalPayments: 0,
      netSpend: 0,
      transactionCount: 0,
      refundCredits: 0,
      linkedRefundCount: 0,
    };

    // Safe-to-spend (best-effort).
    let safeToSpend: number | null = null;
    try {
      const sts = await computeSafeToSpend({
        userId: user.id,
        householdId: household.id,
        currency: targetCcy,
        asOfDate: today,
      });
      safeToSpend = sts.value;
    } catch {
      // Non-fatal: some households have no safe-to-spend settings configured.
    }

    res.json({
      asOf: today,
      windowStart,
      windowEnd: today,
      currency: targetCcy,
      netWorth: nw.total,
      assetsTotal: nw.assetsTotal,
      liabilitiesTotal: nw.liabilitiesTotal,
      totalSpend30d: metrics.totalSpend,
      totalCredits30d: metrics.totalCredits,
      netSpend30d: metrics.netSpend,
      transactionCount30d: metrics.transactionCount,
      safeToSpend,
      partial: nw.partial,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/v1/_ping
 *
 * Liveness probe — returns 200 with the authenticated user id and household
 * id. Useful for scripts to verify a token is valid before making real calls.
 */
router.get('/_ping', (req, res) => {
  const { user, household } = req.reportingAuth!;
  res.json({ ok: true, userId: user.id, householdId: household.id });
});

export default router;
