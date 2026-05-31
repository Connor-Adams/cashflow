/**
 * Reporting API — Bearer-auth router for cfr_ tokens (#429, #430, #431).
 * All routes are GET-only (enforced by reportingAuth middleware).
 * Household scoped via req.reportingAuth.household.id.
 */

import { Router } from 'express';
import { Op } from 'sequelize';
import {
  Account,
  Transaction,
  TaxReserveSetting,
  PlannedEvent,
} from '../models';
import { buildNetWorthAt, buildSeries } from '../networth/aggregate';
import { aggregateMonthly, type MonthlyTxnRow } from '../summary/aggregateMonthly';
import { detectRecurring, type RecurringInputTxn } from './recurring';
import { num } from '../util/numbers';

const router = Router();

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 180;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function nMonthsAgo(n: number): string {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - n, 1);
  return d.toISOString().slice(0, 10);
}

// --- GET /api/v1/summary ---
router.get('/summary', async (req, res, next) => {
  try {
    const householdId = req.reportingAuth!.household.id;
    const asOf = todayIso();

    const accounts = await Account.findAll({
      where: { householdId },
      attributes: ['id', 'defaultCurrency'],
      raw: true,
    });
    const accountIds = accounts.map((a) => a.id);

    // Default currency from query param or fallback to CAD
    const currency = String(req.query.currency ?? 'CAD').toUpperCase().slice(0, 3);

    // Net worth
    const nw = await buildNetWorthAt(asOf, accountIds);
    const netWorth = nw.total;

    // Liquid cash (checking + savings + cash accounts only)
    const liquidCashAccounts = await Account.findAll({
      where: { id: { [Op.in]: accountIds }, accountType: { [Op.in]: ['checking', 'savings', 'cash'] } },
      attributes: ['id'],
      raw: true,
    });
    const liquidIds = liquidCashAccounts.map((a) => a.id);

    // Monthly aggregates for the last 3 months
    const dateFrom = nMonthsAgo(3);
    const txnRows = await Transaction.findAll({
      where: {
        accountId: { [Op.in]: accountIds },
        date: { [Op.gte]: dateFrom },
        currency,
      },
      attributes: ['id', 'accountId', 'date', 'currency', 'finalCategory', 'finalBusiness', 'finalSplitType', 'merchantRaw', 'merchantClean', 'amount', 'txnType', 'businessAmount'],
      raw: true,
    }) as unknown as MonthlyTxnRow[];

    const monthly = aggregateMonthly(txnRows, undefined);
    const recentMonths = monthly.points.filter((p) => p.currency === currency);
    const avgMonthlyBurn = recentMonths.length > 0
      ? recentMonths.reduce((s, p) => s + p.sumAmount, 0) / recentMonths.length
      : 0;
    // Credits (income) — positive amounts in the period
    const creditTxns = txnRows.filter((r) => {
      const a = num(r.amount);
      return a !== null && a > 0;
    });
    const totalCredits = creditTxns.reduce((s, r) => s + (num(r.amount) ?? 0), 0);
    const monthlyIncome = recentMonths.length > 0 ? totalCredits / recentMonths.length : 0;

    const monthlyBurn = Math.abs(avgMonthlyBurn);
    const monthlySavingsRate = monthlyIncome > 0 ? ((monthlyIncome - monthlyBurn) / monthlyIncome) * 100 : 0;
    const runwayMonths = monthlyBurn > 0 ? netWorth / monthlyBurn : null;

    // Tax reserve
    const taxReserve = await TaxReserveSetting.findOne({ where: { householdId, currency }, raw: true });
    const reservePct = Number(taxReserve?.reservePercent ?? 0.25);
    const taxReserveRequired = monthlyBurn * reservePct;
    const taxReserveActual = 0; // would require more complex calculation

    res.json({
      asOf,
      currency,
      netWorth,
      liquidCash: liquidIds.length,
      monthlyBurn,
      monthlyIncome,
      monthlySavingsRate,
      runwayMonths,
      taxReserveRequired,
      taxReserveActual,
    });
  } catch (e) {
    next(e);
  }
});

// --- GET /api/v1/net-worth?start&end&interval=day|week|month ---
router.get('/net-worth', async (req, res, next) => {
  try {
    const householdId = req.reportingAuth!.household.id;
    const today = todayIso();
    const start = String(req.query.start ?? nMonthsAgo(12));
    const end = String(req.query.end ?? today);
    const interval = String(req.query.interval ?? 'month');

    if (!ISO_DATE_RE.test(start) || !ISO_DATE_RE.test(end)) {
      res.status(400).json({ error: 'start and end must be YYYY-MM-DD' });
      return;
    }
    const granularity: 'monthly' | 'daily' =
      interval === 'day' ? 'daily' : 'monthly';

    const accounts = await Account.findAll({
      where: { householdId },
      attributes: ['id'],
      raw: true,
    });
    const accountIds = accounts.map((a) => a.id);

    const series = await buildSeries(start, end, granularity, accountIds);
    res.json(series);
  } catch (e) {
    next(e);
  }
});

// --- GET /api/v1/accounts ---
router.get('/accounts', async (req, res, next) => {
  try {
    const householdId = req.reportingAuth!.household.id;
    const rows = await Account.findAll({
      where: { householdId },
      order: [['name', 'ASC']],
    });
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

// --- GET /api/v1/cashflow/monthly?start&end ---
router.get('/cashflow/monthly', async (req, res, next) => {
  try {
    const householdId = req.reportingAuth!.household.id;
    const start = String(req.query.start ?? nMonthsAgo(12));
    const end = String(req.query.end ?? todayIso());

    if (!ISO_DATE_RE.test(start) || !ISO_DATE_RE.test(end)) {
      res.status(400).json({ error: 'start and end must be YYYY-MM-DD' });
      return;
    }

    const accounts = await Account.findAll({
      where: { householdId },
      attributes: ['id'],
      raw: true,
    });
    const accountIds = accounts.map((a) => a.id);

    if (accountIds.length === 0) {
      res.json({ points: [], categoryPoints: [] });
      return;
    }

    const rows = await Transaction.findAll({
      where: {
        accountId: { [Op.in]: accountIds },
        date: { [Op.gte]: start, [Op.lte]: end },
      },
      attributes: ['id', 'accountId', 'date', 'currency', 'finalCategory', 'finalBusiness', 'finalSplitType', 'merchantRaw', 'merchantClean', 'amount', 'txnType', 'businessAmount'],
      raw: true,
    }) as unknown as MonthlyTxnRow[];

    const result = aggregateMonthly(rows, undefined);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

// --- GET /api/v1/transactions?start&end&category&accountId&limit&cursor ---
router.get('/transactions', async (req, res, next) => {
  try {
    const householdId = req.reportingAuth!.household.id;
    const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50)));
    const cursor = req.query.cursor ? Number(req.query.cursor) : null;

    const accounts = await Account.findAll({
      where: { householdId },
      attributes: ['id'],
      raw: true,
    });
    const accountIds = accounts.map((a) => a.id);

    if (accountIds.length === 0) {
      res.json({ transactions: [], nextCursor: null });
      return;
    }

    const where: Record<string, unknown> = {
      accountId: { [Op.in]: accountIds },
    };
    const dateCond: { [Op.gte]?: string; [Op.lte]?: string } = {};
    if (req.query.start) dateCond[Op.gte] = String(req.query.start);
    if (req.query.end) dateCond[Op.lte] = String(req.query.end);
    if (req.query.start || req.query.end) where.date = dateCond;
    if (req.query.category) where.finalCategory = String(req.query.category);
    if (req.query.accountId) {
      const aid = Number(req.query.accountId);
      if (accountIds.includes(aid)) where.accountId = aid;
      else where.accountId = -1; // no match
    }
    if (cursor !== null) where.id = { [Op.lt]: cursor };

    const rows = await Transaction.findAll({
      where,
      order: [['id', 'DESC']],
      limit: limit + 1,
    });

    const hasMore = rows.length > limit;
    const transactions = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? transactions[transactions.length - 1].id : null;

    res.json({ transactions, nextCursor });
  } catch (e) {
    next(e);
  }
});

// --- GET /api/v1/projections ---
router.get('/projections', async (req, res, next) => {
  try {
    const householdId = req.reportingAuth!.household.id;
    const today = todayIso();
    const endDate = new Date();
    endDate.setUTCDate(endDate.getUTCDate() + 90);
    const dateTo = endDate.toISOString().slice(0, 10);

    const plannedEvents = await PlannedEvent.findAll({
      where: {
        householdId,
        date: { [Op.gte]: today, [Op.lte]: dateTo },
      },
      order: [['date', 'ASC']],
    });

    res.json({ projections: plannedEvents });
  } catch (e) {
    next(e);
  }
});

// --- Issue #431 derived metric endpoints ---

const ESSENTIAL_CATEGORIES = [
  'housing', 'rent', 'mortgage', 'utilities', 'groceries',
  'insurance', 'transport', 'healthcare', 'debt',
];

// --- GET /api/v1/runway ---
router.get('/runway', async (req, res, next) => {
  try {
    const householdId = req.reportingAuth!.household.id;
    const dateFrom = nMonthsAgo(3);

    const accounts = await Account.findAll({
      where: { householdId },
      attributes: ['id'],
      raw: true,
    });
    const accountIds = accounts.map((a) => a.id);

    if (accountIds.length === 0) {
      res.json({ essentialBurn: 0, lifestyleBurn: 0, totalBurn: 0, runwayMonths: null });
      return;
    }

    const txns = await Transaction.findAll({
      where: {
        accountId: { [Op.in]: accountIds },
        date: { [Op.gte]: dateFrom },
      },
      attributes: ['amount', 'finalCategory', 'currency'],
      raw: true,
    }) as unknown as Array<{ amount: unknown; finalCategory: string | null; currency: string }>;

    let essentialBurn = 0;
    let lifestyleBurn = 0;
    for (const t of txns) {
      const a = num(t.amount);
      if (a === null || a >= 0) continue; // skip income
      const abs = Math.abs(a);
      if (t.finalCategory && ESSENTIAL_CATEGORIES.includes(t.finalCategory.toLowerCase())) {
        essentialBurn += abs;
      } else {
        lifestyleBurn += abs;
      }
    }
    const months = 3;
    essentialBurn /= months;
    lifestyleBurn /= months;
    const totalBurn = essentialBurn + lifestyleBurn;

    const nw = await buildNetWorthAt(todayIso(), accountIds);
    const runwayMonths = totalBurn > 0 ? nw.total / totalBurn : null;

    res.json({ essentialBurn, lifestyleBurn, totalBurn, runwayMonths });
  } catch (e) {
    next(e);
  }
});

// --- GET /api/v1/spending/by-category?start&end ---
router.get('/spending/by-category', async (req, res, next) => {
  try {
    const householdId = req.reportingAuth!.household.id;
    const start = String(req.query.start ?? nMonthsAgo(3));
    const end = String(req.query.end ?? todayIso());

    const accounts = await Account.findAll({
      where: { householdId },
      attributes: ['id'],
      raw: true,
    });
    const accountIds = accounts.map((a) => a.id);

    if (accountIds.length === 0) {
      res.json({ categories: [] });
      return;
    }

    const txns = await Transaction.findAll({
      where: {
        accountId: { [Op.in]: accountIds },
        date: { [Op.gte]: start, [Op.lte]: end },
      },
      attributes: ['amount', 'finalCategory', 'currency'],
      raw: true,
    }) as unknown as Array<{ amount: unknown; finalCategory: string | null; currency: string }>;

    const byCategory = new Map<string, { category: string | null; total: number; currency: string }>();
    for (const t of txns) {
      const a = num(t.amount);
      if (a === null || a >= 0) continue;
      const key = `${t.finalCategory ?? ''}|${t.currency}`;
      const existing = byCategory.get(key);
      if (existing) {
        existing.total += Math.abs(a);
      } else {
        byCategory.set(key, { category: t.finalCategory, total: Math.abs(a), currency: t.currency });
      }
    }

    res.json({
      categories: Array.from(byCategory.values()).sort((a, b) => b.total - a.total),
    });
  } catch (e) {
    next(e);
  }
});

// --- GET /api/v1/recurring ---
router.get('/recurring', async (req, res, next) => {
  try {
    const householdId = req.reportingAuth!.household.id;
    const since = new Date(Date.now() - DEFAULT_WINDOW_DAYS * MS_PER_DAY).toISOString().slice(0, 10);

    const accounts = await Account.findAll({
      where: { householdId },
      attributes: ['id'],
      raw: true,
    });
    const accountIds = accounts.map((a) => a.id);

    if (accountIds.length === 0) {
      res.json({ items: [] });
      return;
    }

    const rows = await Transaction.findAll({
      where: {
        accountId: { [Op.in]: accountIds },
        date: { [Op.gte]: since },
      },
      attributes: ['date', 'currency', 'amount', 'merchantRaw', 'merchantClean', 'finalCategory'],
      raw: true,
    }) as unknown as Array<{ date: string; currency: string; amount: unknown; merchantRaw: string | null; merchantClean: string | null; finalCategory: string | null }>;

    const inputs: RecurringInputTxn[] = rows
      .map((r) => ({
        merchant: r.merchantClean ?? r.merchantRaw ?? '',
        amount: num(r.amount) ?? 0,
        currency: r.currency,
        date: r.date,
        category: r.finalCategory,
      }))
      .filter((r) => r.amount < 0); // charges only

    const items = detectRecurring(inputs);
    res.json({ items });
  } catch (e) {
    next(e);
  }
});

// --- GET /api/v1/tax?year ---
router.get('/tax', async (req, res, next) => {
  try {
    const householdId = req.reportingAuth!.household.id;
    const year = Number(req.query.year ?? new Date().getUTCFullYear());

    const taxReserves = await TaxReserveSetting.findAll({
      where: { householdId },
      raw: true,
    });

    const accounts = await Account.findAll({
      where: { householdId },
      attributes: ['id'],
      raw: true,
    });
    const accountIds = accounts.map((a) => a.id);

    const dateFrom = `${year}-01-01`;
    const dateTo = `${year}-12-31`;

    let totalIncome = 0;
    if (accountIds.length > 0) {
      const incomeTxns = await Transaction.findAll({
        where: {
          accountId: { [Op.in]: accountIds },
          date: { [Op.gte]: dateFrom, [Op.lte]: dateTo },
        },
        attributes: ['amount', 'currency'],
        raw: true,
      }) as unknown as Array<{ amount: unknown; currency: string }>;

      for (const t of incomeTxns) {
        const a = num(t.amount);
        if (a !== null && a > 0) totalIncome += a;
      }
    }

    res.json({
      year,
      taxReserveSettings: taxReserves,
      estimatedIncome: totalIncome,
    });
  } catch (e) {
    next(e);
  }
});

// --- GET /api/v1/events?start&end&limit ---
router.get('/events', async (req, res, next) => {
  try {
    const householdId = req.reportingAuth!.household.id;
    const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50)));
    const start = req.query.start ? String(req.query.start) : undefined;
    const end = req.query.end ? String(req.query.end) : undefined;

    const where: Record<string, unknown> = { householdId };
    if (start || end) {
      const dateCond: { [Op.gte]?: string; [Op.lte]?: string } = {};
      if (start) dateCond[Op.gte] = start;
      if (end) dateCond[Op.lte] = end;
      where.date = dateCond;
    }

    const events = await PlannedEvent.findAll({
      where,
      order: [['date', 'ASC']],
      limit,
    });

    res.json({ events });
  } catch (e) {
    next(e);
  }
});

export default router;
