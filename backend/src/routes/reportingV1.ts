/**
 * GET-only reporting API (issue #429–430). All routes require a cfr_ bearer
 * token and are household-scoped via req.reportingAuth.
 *
 * v1 contract: all money values are numbers (not strings), currency is the
 * household's default unless overridden by ?currency=. Dates are YYYY-MM-DD.
 */
import { Router } from 'express';
import { Op } from 'sequelize';
import { Account, Transaction, PlannedEvent } from '../models';
import {
  aggregateDashboard,
  type AccountRow,
  type SummaryTxnRow,
} from '../summary/aggregateDashboard';
import {
  aggregateMonthly,
  type MonthlyTxnRow,
} from '../summary/aggregateMonthly';
import { loadItemAllocationContext } from '../summary/loadItemAllocations';
import { buildNetWorthAt, buildSeries } from '../networth/aggregate';
import { computeSafeToSpend } from '../cashflow/safeToSpend';
import { buildForecast, type ForecastOccurrence } from '../forecast/buildForecast';
import { expandRecurrence, type PlannedEventLike } from '../forecast/expandRecurrence';

const router = Router();

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** n days ago relative to today */
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

/** n days from today */
function daysFromNow(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Parse ?currency if it's a 3-letter code, else null. */
function parseCurrency(raw: unknown): string | null {
  return typeof raw === 'string' && /^[A-Z]{3}$/.test(raw) ? raw : null;
}

/**
 * GET /api/v1/_ping
 *
 * Liveness probe — returns 200 with the authenticated user id and household id.
 */
router.get('/_ping', (req, res) => {
  const { user, household } = req.reportingAuth!;
  res.json({ ok: true, userId: user.id, householdId: household.id });
});

/**
 * GET /api/v1/summary
 *
 * Headline numbers: current net worth, 30-day spend/income, safe-to-spend.
 */
router.get('/summary', async (req, res, next) => {
  try {
    const { user, household } = req.reportingAuth!;
    const targetCcy = parseCurrency(req.query.currency) ?? 'CAD';
    const today = todayIso();
    const windowStart = daysAgo(30);

    const accounts = await Account.findAll({
      where: { householdId: household.id, closedAt: { [Op.or]: [null, { [Op.gt]: today }] } },
      attributes: ['id', 'name', 'shortCode', 'accountType', 'defaultCurrency'],
      raw: true,
    });
    const accountIds = accounts.map((a) => (a as unknown as { id: number }).id);

    const nw = await buildNetWorthAt(today, accountIds);

    const txns = await Transaction.findAll({
      where: { householdId: household.id, date: { [Op.between]: [windowStart, today] } },
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
      // Non-fatal — no settings configured.
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
 * GET /api/v1/net-worth
 *
 * Monthly net-worth series for the last 12 months.
 * ?from=YYYY-MM-DD&to=YYYY-MM-DD override the window.
 * ?granularity=daily|monthly (default monthly)
 */
router.get('/net-worth', async (req, res, next) => {
  try {
    const { household } = req.reportingAuth!;
    const today = todayIso();
    const from =
      typeof req.query.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from)
        ? req.query.from
        : daysAgo(365);
    const to =
      typeof req.query.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to)
        ? req.query.to
        : today;
    const granularity =
      req.query.granularity === 'daily' ? 'daily' : 'monthly';

    const accounts = await Account.findAll({
      where: { householdId: household.id },
      attributes: ['id'],
      raw: true,
    });
    const accountIds = accounts.map((a) => (a as unknown as { id: number }).id);
    const series = await buildSeries(from, to, granularity, accountIds);
    res.json(series);
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/v1/accounts
 *
 * List all open accounts with type, currency, and current balance (from
 * transaction stream; holdings-based accounts show 0 for balance).
 */
router.get('/accounts', async (req, res, next) => {
  try {
    const { household } = req.reportingAuth!;
    const today = todayIso();
    const accounts = await Account.findAll({
      where: {
        householdId: household.id,
        closedAt: { [Op.or]: [null, { [Op.gt]: today }] },
      },
      attributes: [
        'id', 'name', 'owner', 'accountType', 'defaultCurrency',
        'shortCode', 'taxStatus', 'visibility', 'closedAt',
      ],
      order: [['name', 'ASC']],
    });
    res.json(accounts);
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/v1/cashflow/monthly
 *
 * Monthly income / expense totals for the requested window.
 * ?from=YYYY-MM-DD&to=YYYY-MM-DD (default: last 12 months)
 * ?currency=CAD (default CAD)
 */
router.get('/cashflow/monthly', async (req, res, next) => {
  try {
    const { household } = req.reportingAuth!;
    const today = todayIso();
    const from =
      typeof req.query.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from)
        ? req.query.from
        : daysAgo(365);
    const to =
      typeof req.query.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to)
        ? req.query.to
        : today;

    const [txns, accounts] = await Promise.all([
      Transaction.findAll({
        where: { householdId: household.id, date: { [Op.between]: [from, to] } },
        attributes: [
          'id', 'accountId', 'date', 'currency', 'finalCategory', 'amount',
          'txnType', 'merchantRaw', 'merchantClean',
        ],
        raw: true,
      }),
      Account.findAll({
        where: { householdId: household.id },
        attributes: ['id', 'accountType'],
        raw: true,
      }),
    ]);

    const accountTypeById = new Map<number, string | null>(
      (accounts as unknown as Array<{ id: number; accountType: string | null }>).map(
        (a) => [a.id, a.accountType],
      ),
    );
    const itemCtx = await loadItemAllocationContext(
      txns.map((r) => (r as unknown as { id: number }).id),
    );
    const result = aggregateMonthly(txns as unknown as MonthlyTxnRow[], accountTypeById, itemCtx);
    res.json(result.points);
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/v1/transactions
 *
 * Paginated transaction list with optional filters.
 * ?from=YYYY-MM-DD&to=YYYY-MM-DD&category=Food&accountId=1
 * ?limit=100 (max 500)&offset=0
 */
router.get('/transactions', async (req, res, next) => {
  try {
    const { household } = req.reportingAuth!;
    const today = todayIso();

    const from =
      typeof req.query.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from)
        ? req.query.from
        : daysAgo(30);
    const to =
      typeof req.query.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to)
        ? req.query.to
        : today;
    const limit = Math.min(500, Math.max(1, parseInt(String(req.query.limit ?? '100'), 10) || 100));
    const offset = Math.max(0, parseInt(String(req.query.offset ?? '0'), 10) || 0);

    const where: Record<string, unknown> = {
      householdId: household.id,
      date: { [Op.between]: [from, to] },
    };
    if (typeof req.query.category === 'string' && req.query.category) {
      where.finalCategory = req.query.category;
    }
    if (typeof req.query.accountId === 'string' && req.query.accountId) {
      const aid = parseInt(req.query.accountId, 10);
      if (Number.isInteger(aid)) where.accountId = aid;
    }

    const { count, rows } = await Transaction.findAndCountAll({
      where,
      order: [['date', 'DESC'], ['id', 'DESC']],
      limit,
      offset,
      attributes: [
        'id', 'accountId', 'date', 'currency', 'amount', 'merchantRaw',
        'merchantClean', 'merchantCanonical', 'finalCategory', 'txnType',
        'notes', 'reviewFlag', 'status',
      ],
    });

    res.json({ total: count, limit, offset, transactions: rows });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/v1/projections
 *
 * Forward cashflow projection combining current cash balance and planned events.
 * ?days=30|90 (default 30; max 90)
 * ?currency=CAD
 */
router.get('/projections', async (req, res, next) => {
  try {
    const { household } = req.reportingAuth!;
    const today = todayIso();
    const targetCcy = parseCurrency(req.query.currency) ?? 'CAD';
    const days = Math.min(90, Math.max(7, parseInt(String(req.query.days ?? '30'), 10) || 30));
    const dateTo = daysFromNow(days);

    // Opening balance: sum of liquid account balances in target currency.
    const accounts = await Account.findAll({
      where: {
        householdId: household.id,
        closedAt: { [Op.or]: [null, { [Op.gt]: today }] },
      },
      attributes: ['id', 'accountType', 'defaultCurrency'],
      raw: true,
    });
    const liquidAccountIds = (accounts as unknown as Array<{ id: number; accountType: string; defaultCurrency: string | null }>)
      .filter((a) => ['checking', 'savings', 'cash'].includes(a.accountType ?? ''))
      .map((a) => a.id);

    let openingBalance = 0;
    if (liquidAccountIds.length > 0) {
      const balResult = await Transaction.findAll({
        where: { accountId: liquidAccountIds, date: { [Op.lte]: today } },
        attributes: [
          [Transaction.sequelize!.fn('SUM', Transaction.sequelize!.col('amount')), 'total'],
        ],
        raw: true,
      });
      openingBalance = Number((balResult[0] as unknown as { total: string | null }).total ?? 0) || 0;
    }

    // Planned events in the projection window.
    const planned = await PlannedEvent.findAll({
      where: {
        householdId: household.id,
        status: 'pending',
        expectedDate: { [Op.lte]: dateTo },
      },
    });

    const occurrences: ForecastOccurrence[] = [];
    for (const row of planned) {
      const eventLike: PlannedEventLike = {
        id: row.id,
        expectedDate: row.expectedDate,
        recurrenceRule: row.recurrenceRule,
        status: row.status,
      };
      const amount = Number(row.amount);
      if (!Number.isFinite(amount)) continue;
      const direction: ForecastOccurrence['direction'] =
        ['income', 'refund'].includes(row.type ?? '') ? 'in' :
        ['transfer', 'savings_contribution'].includes(row.type ?? '') ? 'neutral' : 'out';
      for (const occ of expandRecurrence(eventLike, today, dateTo)) {
        occurrences.push({
          date: occ.date,
          amount,
          direction,
          sourceType: 'planned_event',
          sourceId: row.id,
          sourceName: row.name,
          accountId: row.accountId,
        });
      }
    }

    const forecast = buildForecast({
      openingBalance,
      occurrences,
      dateFrom: today,
      dateTo,
      currency: targetCcy,
    });

    res.json({
      currency: targetCcy,
      dateFrom: today,
      dateTo,
      openingBalance: forecast.openingBalance,
      projectedClosingBalance: forecast.projectedClosingBalance,
      lowestProjectedBalance: forecast.lowestProjectedBalance,
      lowestProjectedBalanceDate: forecast.lowestProjectedBalanceDate,
      dailyPoints: forecast.dailyPoints,
      eventCount: occurrences.length,
    });
  } catch (e) {
    next(e);
  }
});

export default router;
