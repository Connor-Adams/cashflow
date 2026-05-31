/**
 * GET-only reporting API (issue #429–430). All routes require a cfr_ bearer
 * token and are household-scoped via req.reportingAuth.
 *
 * v1 contract: all money values are numbers (not strings), currency is the
 * household's default unless overridden by ?currency=. Dates are YYYY-MM-DD.
 */
import { Router } from 'express';
import { Op } from 'sequelize';
import { Account, FinanceEvent, PlannedEvent, Subscription, TaxReserveSetting, Transaction } from '../models';
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

/**
 * Categories that represent essential living costs for runway calculation.
 * Partial case-insensitive match on finalCategory.
 */
const ESSENTIAL_KEYWORDS = [
  'rent', 'mortgage', 'housing', 'utilities', 'grocery', 'groceries', 'food',
  'insurance', 'transport', 'transit', 'healthcare', 'medical', 'prescription',
  'internet', 'phone', 'childcare', 'debt', 'loan',
];

function isEssential(category: string | null): boolean {
  if (!category) return false;
  const lc = category.toLowerCase();
  return ESSENTIAL_KEYWORDS.some((kw) => lc.includes(kw));
}

/**
 * GET /api/v1/runway
 *
 * Liquid cash balance + monthly burn split (essential vs lifestyle) + runway months.
 * ?window=90 (days to average burn over, default 90, max 365)
 * ?currency=CAD
 */
router.get('/runway', async (req, res, next) => {
  try {
    const { household } = req.reportingAuth!;
    const today = todayIso();
    const targetCcy = parseCurrency(req.query.currency) ?? 'CAD';
    const window = Math.min(365, Math.max(30, parseInt(String(req.query.window ?? '90'), 10) || 90));
    const windowStart = daysAgo(window);

    const accounts = await Account.findAll({
      where: {
        householdId: household.id,
        closedAt: { [Op.or]: [null, { [Op.gt]: today }] },
      },
      attributes: ['id', 'accountType', 'defaultCurrency'],
      raw: true,
    });
    const liquidIds = (accounts as unknown as Array<{ id: number; accountType: string | null; defaultCurrency: string | null }>)
      .filter((a) => ['checking', 'savings', 'cash'].includes(a.accountType ?? ''))
      .map((a) => a.id);

    let liquidCash = 0;
    if (liquidIds.length > 0) {
      const bal = await Transaction.findAll({
        where: { accountId: liquidIds, date: { [Op.lte]: today } },
        attributes: [[Transaction.sequelize!.fn('SUM', Transaction.sequelize!.col('amount')), 'total']],
        raw: true,
      });
      liquidCash = Number((bal[0] as unknown as { total: string | null }).total ?? 0) || 0;
    }

    // Fetch spend transactions for the window (negative amounts = spend).
    const txns = await Transaction.findAll({
      where: {
        householdId: household.id,
        date: { [Op.between]: [windowStart, today] },
      },
      attributes: ['amount', 'finalCategory', 'currency', 'txnType'],
      raw: true,
    });

    let totalSpend = 0;
    let essentialSpend = 0;
    for (const t of txns as unknown as Array<{ amount: string; finalCategory: string | null; currency: string; txnType: string | null }>) {
      const amt = Number(t.amount);
      if (!Number.isFinite(amt) || amt >= 0) continue; // skip income / zero
      const spend = Math.abs(amt);
      totalSpend += spend;
      if (isEssential(t.finalCategory)) essentialSpend += spend;
    }

    const months = window / 30;
    const averageMonthlyBurn = totalSpend / months;
    const essentialMonthlyBurn = essentialSpend / months;
    const lifestyleMonthlyBurn = averageMonthlyBurn - essentialMonthlyBurn;
    const runwayMonths = averageMonthlyBurn > 0 ? liquidCash / averageMonthlyBurn : null;
    const conservativeRunwayMonths = essentialMonthlyBurn > 0 ? liquidCash / essentialMonthlyBurn : null;

    res.json({
      asOf: today,
      currency: targetCcy,
      windowDays: window,
      liquidCash,
      averageMonthlyBurn: Math.round(averageMonthlyBurn * 100) / 100,
      essentialMonthlyBurn: Math.round(essentialMonthlyBurn * 100) / 100,
      lifestyleMonthlyBurn: Math.round(lifestyleMonthlyBurn * 100) / 100,
      runwayMonths: runwayMonths != null ? Math.round(runwayMonths * 10) / 10 : null,
      conservativeRunwayMonths: conservativeRunwayMonths != null ? Math.round(conservativeRunwayMonths * 10) / 10 : null,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/v1/spending/by-category
 *
 * Per-category spend with share, count, and trend vs the previous same-length period.
 * ?from=YYYY-MM-DD&to=YYYY-MM-DD (default: last 30 days)
 * ?currency=CAD
 */
router.get('/spending/by-category', async (req, res, next) => {
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

    const periodDays = Math.max(1, (new Date(to).getTime() - new Date(from).getTime()) / 86_400_000);
    const prevTo = from;
    const prevFrom = new Date(new Date(from).getTime() - periodDays * 86_400_000)
      .toISOString()
      .slice(0, 10);

    const [current, previous] = await Promise.all([
      Transaction.findAll({
        where: { householdId: household.id, date: { [Op.between]: [from, to] } },
        attributes: ['amount', 'finalCategory'],
        raw: true,
      }),
      Transaction.findAll({
        where: { householdId: household.id, date: { [Op.between]: [prevFrom, prevTo] } },
        attributes: ['amount', 'finalCategory'],
        raw: true,
      }),
    ]);

    type Row = { amount: string; finalCategory: string | null };
    function accumulate(rows: Row[]) {
      const map = new Map<string, { spend: number; count: number }>();
      for (const t of rows) {
        const amt = Number(t.amount);
        if (!Number.isFinite(amt) || amt >= 0) continue;
        const key = t.finalCategory ?? '(uncategorized)';
        const entry = map.get(key) ?? { spend: 0, count: 0 };
        entry.spend += Math.abs(amt);
        entry.count += 1;
        map.set(key, entry);
      }
      return map;
    }

    const curr = accumulate(current as unknown as Row[]);
    const prev = accumulate(previous as unknown as Row[]);
    const totalSpend = [...curr.values()].reduce((s, v) => s + v.spend, 0);

    const categories = [...curr.entries()]
      .sort(([, a], [, b]) => b.spend - a.spend)
      .map(([category, { spend, count }]) => {
        const prevSpend = prev.get(category)?.spend ?? 0;
        const trend =
          prevSpend === 0
            ? 'new'
            : spend > prevSpend * 1.05
              ? 'up'
              : spend < prevSpend * 0.95
                ? 'down'
                : 'flat';
        return {
          category,
          spend: Math.round(spend * 100) / 100,
          share: totalSpend > 0 ? Math.round((spend / totalSpend) * 10000) / 100 : 0,
          count,
          prevSpend: Math.round(prevSpend * 100) / 100,
          trend,
        };
      });

    res.json({ from, to, totalSpend: Math.round(totalSpend * 100) / 100, categories });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/v1/recurring
 *
 * Unified list of all recurring money movements: active subscriptions +
 * recurring PlannedEvents.
 */
router.get('/recurring', async (req, res, next) => {
  try {
    const { household } = req.reportingAuth!;
    const today = todayIso();

    const [subscriptions, planned] = await Promise.all([
      Subscription.findAll({
        where: { householdId: household.id, status: 'active' },
        attributes: ['id', 'merchantName', 'amount', 'currency', 'cadence', 'annualizedCost', 'nextExpectedDate', 'category'],
        raw: true,
      }),
      PlannedEvent.findAll({
        where: {
          householdId: household.id,
          status: 'pending',
          recurrenceRule: { [Op.ne]: null },
        },
        attributes: ['id', 'name', 'amount', 'currency', 'type', 'expectedDate', 'recurrenceRule'],
        raw: true,
      }),
    ]);

    type SubRow = { id: number; merchantName: string; amount: string; currency: string; cadence: string; annualizedCost: string; nextExpectedDate: string | null; category: string | null };
    type EventRow = { id: number; name: string; amount: string; currency: string; type: string | null; expectedDate: string; recurrenceRule: string | null };

    const items = [
      ...(subscriptions as unknown as SubRow[]).map((s) => ({
        source: 'subscription' as const,
        id: s.id,
        name: s.merchantName,
        amount: Number(s.amount),
        annualizedCost: Number(s.annualizedCost),
        currency: s.currency,
        cadence: s.cadence,
        category: s.category,
        nextDate: s.nextExpectedDate,
        recurrenceRule: null,
        direction: 'out' as const,
      })),
      ...(planned as unknown as EventRow[]).map((p) => {
        const direction =
          ['income', 'refund'].includes(p.type ?? '') ? 'in' as const :
          ['transfer', 'savings_contribution'].includes(p.type ?? '') ? 'neutral' as const : 'out' as const;
        return {
          source: 'planned_event' as const,
          id: p.id,
          name: p.name,
          amount: Number(p.amount),
          annualizedCost: null,
          currency: p.currency,
          cadence: null,
          category: null,
          nextDate: p.expectedDate,
          recurrenceRule: p.recurrenceRule,
          direction,
        };
      }),
    ];

    res.json({ asOf: today, count: items.length, items });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/v1/tax
 *
 * Tax reserve digest for the household: reserve settings + current year reserve estimate.
 * ?year=2025 (default: current year)
 */
router.get('/tax', async (req, res, next) => {
  try {
    const { household } = req.reportingAuth!;
    const today = todayIso();
    const year =
      typeof req.query.year === 'string' && /^\d{4}$/.test(req.query.year)
        ? parseInt(req.query.year, 10)
        : new Date().getUTCFullYear();

    const yearStart = `${year}-01-01`;
    const yearEnd = `${year}-12-31`;

    const [settings, yearTxns] = await Promise.all([
      TaxReserveSetting.findAll({
        where: { householdId: household.id },
        attributes: ['currency', 'reservePercent', 'note'],
        raw: true,
      }),
      Transaction.findAll({
        where: {
          householdId: household.id,
          date: { [Op.between]: [yearStart, yearEnd <= today ? yearEnd : today] },
        },
        attributes: ['amount', 'currency', 'finalBusiness'],
        raw: true,
      }),
    ]);

    type SettingRow = { currency: string; reservePercent: string; note: string | null };
    type TxnRow = { amount: string; currency: string; finalBusiness: boolean | null };

    const incomePerCurrency = new Map<string, number>();
    for (const t of yearTxns as unknown as TxnRow[]) {
      const amt = Number(t.amount);
      if (!Number.isFinite(amt) || amt <= 0) continue;
      const cur = t.currency ?? 'CAD';
      incomePerCurrency.set(cur, (incomePerCurrency.get(cur) ?? 0) + amt);
    }

    const reserves = (settings as unknown as SettingRow[]).map((s) => {
      const pct = Number(s.reservePercent);
      const yearIncome = incomePerCurrency.get(s.currency) ?? 0;
      const recommendedReserve = yearIncome * (Number.isFinite(pct) ? pct : 0);
      return {
        currency: s.currency,
        reservePercent: Number.isFinite(pct) ? pct : null,
        yearIncome: Math.round(yearIncome * 100) / 100,
        recommendedReserve: Math.round(recommendedReserve * 100) / 100,
        note: s.note ?? null,
      };
    });

    res.json({ year, asOf: today, reserves });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/v1/events
 *
 * Human-meaningful financial timeline from the FinanceEvent log.
 * Returns semantic events relevant to the household, with type remapped to
 * user-facing labels.
 * ?from=YYYY-MM-DD&to=YYYY-MM-DD (default: last 30 days)
 * ?limit=100 (max 500)&offset=0
 */
router.get('/events', async (req, res, next) => {
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

    const { count, rows } = await FinanceEvent.findAndCountAll({
      where: {
        householdId: household.id,
        occurredAt: { [Op.between]: [`${from}T00:00:00.000Z`, `${to}T23:59:59.999Z`] },
      },
      order: [['occurredAt', 'DESC']],
      limit,
      offset,
      attributes: ['id', 'type', 'entityType', 'entityId', 'payload', 'occurredAt'],
    });

    // Remap system event type strings to user-friendly labels.
    const TYPE_LABEL: Record<string, string> = {
      'transaction.created': 'Transaction recorded',
      'transaction.updated': 'Transaction updated',
      'transaction.deleted': 'Transaction removed',
      'import.committed': 'Statements imported',
      'rule.created': 'Rule created',
      'rule.updated': 'Rule updated',
      'rule.deleted': 'Rule deleted',
      'goal.created': 'Goal set',
      'goal.updated': 'Goal updated',
      'goal.achieved': 'Goal achieved',
      'budget.created': 'Budget created',
      'budget.updated': 'Budget updated',
      'planned_event.created': 'Planned event added',
      'planned_event.updated': 'Planned event updated',
      'account.created': 'Account opened',
      'account.updated': 'Account updated',
      'subscription.created': 'Subscription detected',
      'subscription.updated': 'Subscription updated',
      'reimbursement.created': 'Reimbursement tracked',
      'reimbursement.updated': 'Reimbursement updated',
    };

    const events = rows.map((e) => ({
      id: e.id,
      type: e.type,
      label: TYPE_LABEL[e.type] ?? e.type,
      entityType: e.entityType,
      entityId: e.entityId,
      occurredAt: e.occurredAt,
      payload: e.payload,
    }));

    res.json({ from, to, total: count, limit, offset, events });
  } catch (e) {
    next(e);
  }
});

export default router;
