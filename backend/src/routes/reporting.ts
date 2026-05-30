import { Router } from 'express';
import { Op } from 'sequelize';
import { Account, Category, Entity, PlannedEvent, Subscription, Transaction, TaxReserveSetting, TransactionLargePurchaseReview } from '../models';
import { balanceAtDate } from '../networth/balanceAtDate';
import { DEFAULT_TAX_RESERVE_PERCENT } from '../models/TaxReserveSetting';
import { buildNetWorthAt, buildSeries, daysInRange } from '../networth/aggregate';
import { buildForecast } from '../forecast/buildForecast';
import { detectRecurring } from './recurring';

const router = Router();

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function monthsAgoIso(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 10);
}

function monthsFromNow(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function resolveHouseholdAccounts(householdId: number) {
  return Account.findAll({ where: { householdId } });
}

async function resolveAvailableCurrencies(accountIds: number[]): Promise<Set<string>> {
  if (accountIds.length === 0) return new Set();
  const twelveMonthsAgo = monthsAgoIso(12);
  const rows = await Transaction.findAll({
    where: { accountId: { [Op.in]: accountIds }, date: { [Op.gte]: twelveMonthsAgo } },
    attributes: ['currency'],
    group: ['currency'],
  });
  return new Set(rows.map((t) => t.currency));
}

async function resolveCurrency(
  req: { query: Record<string, unknown> },
  availableCurrencies: Set<string>,
): Promise<{ currency: string; err?: string }> {
  let currency = (String(req.query.currency ?? '')).toUpperCase().slice(0, 3);
  if (!currency) {
    currency = availableCurrencies.has('CAD')
      ? 'CAD'
      : availableCurrencies.size > 0
        ? Array.from(availableCurrencies)[0]
        : 'CAD';
  }
  if (availableCurrencies.size > 0 && !availableCurrencies.has(currency)) {
    return { currency, err: `No data for currency ${currency}` };
  }
  return { currency };
}

// ── /summary ─────────────────────────────────────────────────────────────────

router.get('/summary', async (req, res, next) => {
  try {
    const { household } = req.reportingAuth!;
    const householdId = household.id;

    const accounts = await resolveHouseholdAccounts(householdId);
    const accountIds = accounts.map((a) => a.id);
    const availableCurrencies = await resolveAvailableCurrencies(accountIds);
    const { currency, err } = await resolveCurrency(
      req as unknown as { query: Record<string, unknown> },
      availableCurrencies,
    );
    if (err) { res.status(400).json({ error: err }); return; }

    const asOf = todayIso();
    const sixMonthsAgo = monthsAgoIso(6);

    const recentTxns = accountIds.length === 0 ? [] : await Transaction.findAll({
      where: { accountId: { [Op.in]: accountIds }, currency, date: { [Op.gte]: sixMonthsAgo, [Op.lte]: asOf } },
      attributes: ['amount', 'date', 'txnType'],
    });

    const monthlySpend = new Map<string, number>();
    const monthlyIncome = new Map<string, number>();
    for (const txn of recentTxns) {
      const month = txn.date.slice(0, 7);
      const amount = Number(txn.amount);
      if (amount < 0) monthlySpend.set(month, (monthlySpend.get(month) ?? 0) + -amount);
      else if (amount > 0) monthlyIncome.set(month, (monthlyIncome.get(month) ?? 0) + amount);
    }
    const spendValues = Array.from(monthlySpend.values());
    const incomeValues = Array.from(monthlyIncome.values());
    const monthlyBurn = spendValues.length > 0 ? spendValues.reduce((a, b) => a + b, 0) / spendValues.length : 0;
    const monthlyIncomeAvg = incomeValues.length > 0 ? incomeValues.reduce((a, b) => a + b, 0) / incomeValues.length : 0;
    const monthlySavingsRate = monthlyIncomeAvg > 0
      ? Math.max(0, Math.min(1, (monthlyIncomeAvg - monthlyBurn) / monthlyIncomeAvg))
      : 0;

    let netWorth = 0, liquidCash = 0;
    const LIQUID_TYPES = new Set(['checking', 'savings', 'cash']);
    for (const account of accounts) {
      const balances = await balanceAtDate(account, asOf);
      for (const b of balances) {
        if (b.currency !== currency) continue;
        netWorth += b.amount;
        if (LIQUID_TYPES.has(account.accountType ?? '')) liquidCash += b.amount;
      }
    }

    const runwayMonths = monthlyBurn > 0 ? Math.max(0, liquidCash / monthlyBurn) : null;
    const setting = await TaxReserveSetting.findOne({ where: { householdId, currency } });
    const reservePercent = Number(setting?.reservePercent ?? DEFAULT_TAX_RESERVE_PERCENT);
    const taxReserveRequired = round2(monthlyIncomeAvg * 12 * reservePercent);

    res.json({
      asOf: new Date().toISOString(),
      currency,
      netWorth: round2(netWorth),
      liquidCash: round2(liquidCash),
      monthlyBurn: round2(monthlyBurn),
      monthlyIncome: round2(monthlyIncomeAvg),
      monthlySavingsRate: Math.round(monthlySavingsRate * 10000) / 10000,
      runwayMonths: runwayMonths !== null ? round2(runwayMonths) : null,
      taxReserveRequired,
      taxReserveActual: 0,
    });
  } catch (e) { next(e); }
});

// ── /net-worth ────────────────────────────────────────────────────────────────

const VALID_INTERVALS = new Set(['day', 'week', 'month']);

router.get('/net-worth', async (req, res, next) => {
  try {
    const householdId = req.reportingAuth!.household.id;
    const interval = String(req.query.interval ?? 'month');
    if (!VALID_INTERVALS.has(interval)) {
      res.status(400).json({ error: 'interval must be day|week|month' });
      return;
    }
    const today = todayIso();
    const start = String(req.query.start ?? monthsAgoIso(12));
    const end = String(req.query.end ?? today);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      res.status(400).json({ error: 'start and end must be YYYY-MM-DD' });
      return;
    }

    const accounts = await resolveHouseholdAccounts(householdId);
    const accountIds = accounts.map((a) => a.id);

    let granularity: 'monthly' | 'daily' = 'monthly';
    if (interval === 'day') granularity = 'daily';
    else if (interval === 'week') {
      // Build weekly buckets manually
      const allDays = daysInRange(start, end);
      const weekEnds = allDays.filter((_, i) => i % 7 === 6).concat(allDays[allDays.length - 1] ?? []);
      const uniqueWeekEnds = [...new Set(weekEnds)];
      const points = await Promise.all(
        uniqueWeekEnds.map(async (date) => {
          const snap = await buildNetWorthAt(date, accountIds);
          return { date, assets: round2(snap.assetsTotal), liabilities: round2(snap.liabilitiesTotal), netWorth: round2(snap.total) };
        }),
      );
      res.json({ range: { start, end }, points });
      return;
    }

    const series = await buildSeries(start, end, granularity, accountIds);
    const points = series.points.map((p) => ({
      date: p.date,
      assets: round2(p.assetsTotal),
      liabilities: round2(p.liabilitiesTotal),
      netWorth: round2(p.total),
    }));
    res.json({ range: { start, end }, points });
  } catch (e) { next(e); }
});

// ── /accounts ────────────────────────────────────────────────────────────────

const ACCOUNT_TYPE_MAP: Record<string, string> = {
  checking: 'cash',
  savings: 'cash',
  cash: 'cash',
  credit_card: 'credit_card',
  investment: 'investment',
  loan: 'loan',
  other: 'cash',
};

router.get('/accounts', async (req, res, next) => {
  try {
    const householdId = req.reportingAuth!.household.id;
    const accounts = await resolveHouseholdAccounts(householdId);
    const asOf = todayIso();

    const result = await Promise.all(
      accounts.map(async (a) => {
        const balances = await balanceAtDate(a, asOf);
        const currency = a.defaultCurrency ?? 'CAD';
        const balance = balances.find((b) => b.currency === currency)?.amount ?? 0;
        return {
          id: a.id,
          name: a.name,
          type: ACCOUNT_TYPE_MAP[a.accountType ?? ''] ?? 'cash',
          currency,
          balance: round2(balance),
          updatedAt: a.updatedAt,
        };
      }),
    );

    res.json({ accounts: result });
  } catch (e) { next(e); }
});

// ── /cashflow/monthly ─────────────────────────────────────────────────────────

router.get('/cashflow/monthly', async (req, res, next) => {
  try {
    const householdId = req.reportingAuth!.household.id;
    const start = String(req.query.start ?? monthsAgoIso(12));
    const end = String(req.query.end ?? todayIso());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      res.status(400).json({ error: 'start and end must be YYYY-MM-DD' });
      return;
    }

    const accounts = await resolveHouseholdAccounts(householdId);
    const accountIds = accounts.map((a) => a.id);
    const availableCurrencies = await resolveAvailableCurrencies(accountIds);
    const { currency, err } = await resolveCurrency(
      req as unknown as { query: Record<string, unknown> },
      availableCurrencies,
    );
    if (err) { res.status(400).json({ error: err }); return; }

    const txns = accountIds.length === 0 ? [] : await Transaction.findAll({
      where: {
        accountId: { [Op.in]: accountIds },
        currency,
        date: { [Op.gte]: start, [Op.lte]: end },
      },
      attributes: ['amount', 'date', 'txnType'],
    });

    // Bucket by month
    const byMonth = new Map<string, { income: number; expenses: number }>();
    for (const txn of txns) {
      const month = txn.date.slice(0, 7);
      const bucket = byMonth.get(month) ?? { income: 0, expenses: 0 };
      const amount = Number(txn.amount);
      if (amount > 0) bucket.income += amount;
      else if (amount < 0) bucket.expenses += -amount;
      byMonth.set(month, bucket);
    }

    const months = Array.from(byMonth.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, { income, expenses }]) => {
        const netCashflow = income - expenses;
        const savingsRate = income > 0 ? Math.max(0, Math.min(1, netCashflow / income)) : 0;
        return {
          month,
          income: round2(income),
          expenses: round2(expenses),
          netCashflow: round2(netCashflow),
          savingsRate: Math.round(savingsRate * 10000) / 10000,
          // recurringExpenses detection requires deeper analysis; v1 sets 0
          recurringExpenses: 0,
          variableExpenses: round2(expenses),
        };
      });

    res.json({ months });
  } catch (e) { next(e); }
});

// ── /transactions ─────────────────────────────────────────────────────────────

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset)).toString('base64');
}

function decodeCursor(cursor: string): number {
  try {
    const offset = parseInt(Buffer.from(cursor, 'base64').toString('utf8'), 10);
    if (!Number.isFinite(offset) || offset < 0) throw new Error('bad cursor');
    return offset;
  } catch {
    throw Object.assign(new Error('Invalid cursor'), { status: 400 });
  }
}

router.get('/transactions', async (req, res, next) => {
  try {
    const householdId = req.reportingAuth!.household.id;
    const start = req.query.start as string | undefined;
    const end = req.query.end as string | undefined;
    const category = req.query.category as string | undefined;
    const accountIdFilter = req.query.accountId ? Number(req.query.accountId) : undefined;
    const cursorParam = req.query.cursor as string | undefined;
    const rawLimit = parseInt(String(req.query.limit ?? DEFAULT_LIMIT), 10);
    const limit = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT, MAX_LIMIT);

    let offset = 0;
    if (cursorParam) {
      offset = decodeCursor(cursorParam);
    }

    const accounts = await resolveHouseholdAccounts(householdId);
    const accountIds = accounts.map((a) => a.id);
    if (accountIds.length === 0) {
      res.json({ transactions: [] });
      return;
    }

    // Build where clause
    const where: Record<string, unknown> = { accountId: { [Op.in]: accountIds } };
    if (start) where.date = { ...(where.date as object ?? {}), [Op.gte]: start };
    if (end) where.date = { ...(where.date as object ?? {}), [Op.lte]: end };
    if (category) where.finalCategory = category;
    if (accountIdFilter !== undefined) where.accountId = accountIdFilter;

    const { rows, count } = await Transaction.findAndCountAll({
      where: where as Parameters<typeof Transaction.findAndCountAll>[0]['where'],
      order: [['date', 'DESC'], ['id', 'DESC']],
      limit,
      offset,
      attributes: ['id', 'date', 'merchantClean', 'merchantRaw', 'amount', 'currency', 'finalCategory', 'accountId'],
    });

    const nextOffset = offset + rows.length;
    const hasMore = nextOffset < count;

    res.json({
      transactions: rows.map((t) => ({
        id: t.id,
        date: t.date,
        merchant: (t.merchantClean ?? t.merchantRaw) || null,
        amount: round2(Number(t.amount)),
        currency: t.currency,
        category: t.finalCategory,
        accountId: t.accountId,
      })),
      ...(hasMore ? { nextCursor: encodeCursor(nextOffset) } : {}),
    });
  } catch (e) {
    if ((e as Error & { status?: number }).status === 400) {
      res.status(400).json({ error: (e as Error).message });
      return;
    }
    next(e);
  }
});

// ── /projections ──────────────────────────────────────────────────────────────

router.get('/projections', async (req, res, next) => {
  try {
    const householdId = req.reportingAuth!.household.id;

    const accounts = await resolveHouseholdAccounts(householdId);
    const accountIds = accounts.map((a) => a.id);
    const availableCurrencies = await resolveAvailableCurrencies(accountIds);
    const { currency, err } = await resolveCurrency(
      req as unknown as { query: Record<string, unknown> },
      availableCurrencies,
    );
    if (err) { res.status(400).json({ error: err }); return; }

    const asOf = todayIso();

    // Compute opening liquid cash balance in the selected currency
    const LIQUID_TYPES = new Set(['checking', 'savings', 'cash']);
    let openingBalance = 0;
    let investmentsValue = 0;
    let liabilitiesValue = 0;
    for (const account of accounts) {
      const balances = await balanceAtDate(account, asOf);
      for (const b of balances) {
        if (b.currency !== currency) continue;
        if (LIQUID_TYPES.has(account.accountType ?? '')) openingBalance += b.amount;
        else if (account.accountType === 'investment') investmentsValue += b.amount;
        else if (account.accountType === 'loan' || account.accountType === 'credit_card') liabilitiesValue += -b.amount;
      }
    }

    // Trailing 3-month averages for assumptions
    const threeMonthsAgo = monthsAgoIso(3);
    const recentTxns = accountIds.length === 0 ? [] : await Transaction.findAll({
      where: { accountId: { [Op.in]: accountIds }, currency, date: { [Op.gte]: threeMonthsAgo } },
      attributes: ['amount'],
    });
    let totalIncome = 0, totalExpenses = 0;
    for (const t of recentTxns) {
      const a = Number(t.amount);
      if (a > 0) totalIncome += a;
      else if (a < 0) totalExpenses += -a;
    }
    const monthlyIncome = round2(totalIncome / 3);
    const monthlyExpenses = round2(totalExpenses / 3);

    // Build 6-month forward projection with monthly occurrences
    const dateFrom = asOf;
    const dateTo = monthsFromNow(6);

    // Generate monthly income/expense occurrences
    const occurrences: Parameters<typeof buildForecast>[0]['occurrences'] = [];
    const months6 = Array.from({ length: 6 }, (_, i) => {
      const d = new Date();
      d.setMonth(d.getMonth() + i + 1);
      d.setDate(1);
      return d.toISOString().slice(0, 10);
    });
    for (const date of months6) {
      if (monthlyIncome > 0) {
        occurrences.push({ date, amount: monthlyIncome, direction: 'in', sourceType: 'planned_event', sourceId: 0, sourceName: 'avg income', accountId: null });
      }
      if (monthlyExpenses > 0) {
        occurrences.push({ date, amount: monthlyExpenses, direction: 'out', sourceType: 'planned_event', sourceId: 0, sourceName: 'avg expenses', accountId: null });
      }
    }

    const forecast = buildForecast({ openingBalance, occurrences, dateFrom, dateTo, currency });

    const setting = await TaxReserveSetting.findOne({ where: { householdId, currency } });
    const taxRate = Number(setting?.reservePercent ?? DEFAULT_TAX_RESERVE_PERCENT);

    const projections = forecast.dailyPoints.map((p) => ({
      date: p.date,
      projectedCash: round2(p.balance),
      projectedInvestments: round2(investmentsValue),
      projectedNetWorth: round2(p.balance + investmentsValue - liabilitiesValue),
    }));

    res.json({
      assumptions: {
        monthlyIncome,
        monthlyExpenses,
        investmentGrowthRate: 0,
        taxRate,
      },
      projections,
    });
  } catch (e) { next(e); }
});

// ── /runway ───────────────────────────────────────────────────────────────────

const ESSENTIAL_CATEGORIES = new Set([
  'housing', 'rent', 'mortgage', 'utilities', 'groceries', 'insurance',
  'transport', 'transportation', 'healthcare', 'health', 'debt', 'debt_minimum',
]);

router.get('/runway', async (req, res, next) => {
  try {
    const householdId = req.reportingAuth!.household.id;
    const accounts = await resolveHouseholdAccounts(householdId);
    const accountIds = accounts.map((a) => a.id);
    const availableCurrencies = await resolveAvailableCurrencies(accountIds);
    const { currency, err } = await resolveCurrency(
      req as unknown as { query: Record<string, unknown> },
      availableCurrencies,
    );
    if (err) { res.status(400).json({ error: err }); return; }

    const LIQUID_TYPES = new Set(['checking', 'savings', 'cash']);
    let liquidCash = 0;
    const asOf = todayIso();
    for (const account of accounts) {
      if (!LIQUID_TYPES.has(account.accountType ?? '')) continue;
      const balances = await balanceAtDate(account, asOf);
      for (const b of balances) {
        if (b.currency !== currency) continue;
        liquidCash += b.amount;
      }
    }

    const threeMonthsAgo = monthsAgoIso(3);
    const txns = accountIds.length === 0 ? [] : await Transaction.findAll({
      where: {
        accountId: { [Op.in]: accountIds },
        currency,
        date: { [Op.gte]: threeMonthsAgo, [Op.lte]: asOf },
        amount: { [Op.lt]: 0 },
      },
      attributes: ['amount', 'date', 'finalCategory'],
    });

    const byMonth = new Map<string, { total: number; essential: number }>();
    for (const txn of txns) {
      const month = txn.date.slice(0, 7);
      const bucket = byMonth.get(month) ?? { total: 0, essential: 0 };
      const spend = -Number(txn.amount);
      bucket.total += spend;
      const cat = (txn.finalCategory ?? '').toLowerCase();
      if (ESSENTIAL_CATEGORIES.has(cat)) bucket.essential += spend;
      byMonth.set(month, bucket);
    }

    const monthlyTotals = Array.from(byMonth.values());
    const avgBurn = monthlyTotals.length > 0
      ? monthlyTotals.reduce((s, m) => s + m.total, 0) / monthlyTotals.length : 0;
    const avgEssential = monthlyTotals.length > 0
      ? monthlyTotals.reduce((s, m) => s + m.essential, 0) / monthlyTotals.length : 0;
    const avgLifestyle = round2(Math.max(0, avgBurn - avgEssential));
    const maxMonthlyBurn = monthlyTotals.length > 0 ? Math.max(...monthlyTotals.map((m) => m.total)) : 0;

    res.json({
      liquidCash: round2(liquidCash),
      averageMonthlyBurn: round2(avgBurn),
      essentialMonthlyBurn: round2(avgEssential),
      lifestyleMonthlyBurn: avgLifestyle,
      runwayMonths: avgBurn > 0 ? round2(liquidCash / avgBurn) : null,
      conservativeRunwayMonths: maxMonthlyBurn > 0 ? round2(liquidCash / maxMonthlyBurn) : null,
    });
  } catch (e) { next(e); }
});

// ── /spending/by-category ─────────────────────────────────────────────────────

router.get('/spending/by-category', async (req, res, next) => {
  try {
    const householdId = req.reportingAuth!.household.id;
    const today = todayIso();
    const start = String(req.query.start ?? monthsAgoIso(1));
    const end = String(req.query.end ?? today);

    const accounts = await resolveHouseholdAccounts(householdId);
    const accountIds = accounts.map((a) => a.id);
    const availableCurrencies = await resolveAvailableCurrencies(accountIds);
    const { currency, err } = await resolveCurrency(
      req as unknown as { query: Record<string, unknown> },
      availableCurrencies,
    );
    if (err) { res.status(400).json({ error: err }); return; }

    if (accountIds.length === 0) { res.json({ start, end, categories: [] }); return; }

    // Previous period: equal-length window immediately preceding start
    const startMs = new Date(start).getTime();
    const endMs = new Date(end).getTime();
    const periodMs = Math.max(0, endMs - startMs);
    const prevEnd = new Date(startMs - 1).toISOString().slice(0, 10);
    const prevStart = new Date(startMs - periodMs).toISOString().slice(0, 10);

    const [txns, prevTxns, catRows] = await Promise.all([
      Transaction.findAll({
        where: { accountId: { [Op.in]: accountIds }, currency, date: { [Op.gte]: start, [Op.lte]: end }, amount: { [Op.lt]: 0 } },
        attributes: ['amount', 'finalCategory'],
      }),
      Transaction.findAll({
        where: { accountId: { [Op.in]: accountIds }, currency, date: { [Op.gte]: prevStart, [Op.lte]: prevEnd }, amount: { [Op.lt]: 0 } },
        attributes: ['amount', 'finalCategory'],
      }),
      Category.findAll({ where: { householdId } }),
    ]);

    const catNameMap = new Map<string, string>(catRows.map((c) => [c.name, c.name]));

    const byCat = new Map<string, { amount: number; count: number }>();
    let totalSpend = 0;
    for (const txn of txns) {
      const cat = txn.finalCategory ?? 'Uncategorized';
      const spend = -Number(txn.amount);
      const bucket = byCat.get(cat) ?? { amount: 0, count: 0 };
      bucket.amount += spend;
      bucket.count += 1;
      byCat.set(cat, bucket);
      totalSpend += spend;
    }

    const prevByCat = new Map<string, number>();
    for (const txn of prevTxns) {
      const cat = txn.finalCategory ?? 'Uncategorized';
      prevByCat.set(cat, (prevByCat.get(cat) ?? 0) + (-Number(txn.amount)));
    }

    const categories = Array.from(byCat.entries())
      .sort(([, a], [, b]) => b.amount - a.amount)
      .map(([catId, { amount, count }]) => {
        const prevAmount = prevByCat.get(catId) ?? 0;
        const trend = prevAmount > 0 ? round2((amount - prevAmount) / prevAmount) : null;
        return {
          categoryId: catId,
          name: catNameMap.get(catId) ?? catId,
          amount: round2(amount),
          percentage: totalSpend > 0 ? round2(amount / totalSpend) : 0,
          transactionCount: count,
          trendVsPreviousPeriod: trend,
        };
      });

    res.json({ start, end, categories });
  } catch (e) { next(e); }
});

// ── /recurring ────────────────────────────────────────────────────────────────

function parseCadence(rule: string | null): 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'annual' {
  if (!rule) return 'monthly';
  const upper = rule.toUpperCase();
  if (upper.includes('FREQ=YEARLY') || upper.includes('FREQ=ANNUAL')) return 'annual';
  if (upper.includes('FREQ=MONTHLY') && (upper.includes('INTERVAL=3') || upper.includes('INTERVAL=4'))) return 'quarterly';
  if (upper.includes('FREQ=MONTHLY')) return 'monthly';
  if (upper.includes('FREQ=WEEKLY') && upper.includes('INTERVAL=2')) return 'biweekly';
  if (upper.includes('FREQ=WEEKLY')) return 'weekly';
  return 'monthly';
}

function subCadenceToEnum(c: string): 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'annual' {
  if (c === 'weekly') return 'weekly';
  if (c === 'biweekly') return 'biweekly';
  if (c === 'monthly') return 'monthly';
  if (c === 'quarterly') return 'quarterly';
  return 'annual';
}

router.get('/recurring', async (req, res, next) => {
  try {
    const householdId = req.reportingAuth!.household.id;
    const accounts = await resolveHouseholdAccounts(householdId);
    const accountIds = accounts.map((a) => a.id);

    const [subscriptions, plannedEvents] = await Promise.all([
      Subscription.findAll({ where: { householdId, status: { [Op.in]: ['active', 'unknown'] } } }),
      PlannedEvent.findAll({ where: { householdId, recurrenceRule: { [Op.ne]: null } } }),
    ]);

    const sixMonthsAgo = monthsAgoIso(6);
    const recentTxns = accountIds.length === 0 ? [] : await Transaction.findAll({
      where: {
        accountId: { [Op.in]: accountIds },
        date: { [Op.gte]: sixMonthsAgo },
        amount: { [Op.lt]: 0 },
      },
      attributes: ['merchantClean', 'merchantRaw', 'amount', 'currency', 'date', 'finalCategory'],
    });

    const detectedItems = detectRecurring(recentTxns.map((t) => ({
      merchant: t.merchantClean ?? t.merchantRaw ?? null,
      amount: Number(t.amount),
      currency: t.currency,
      date: t.date,
      category: t.finalCategory,
    })));

    type RecurringEntry = {
      id: string; name: string; type: 'income' | 'expense' | 'transfer';
      amount: number; cadence: 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'annual';
      nextExpectedDate: string | null; confidence: number; category: string | null;
    };

    const seen = new Set<string>();
    const recurringItems: RecurringEntry[] = [];

    for (const sub of subscriptions) {
      const cadence = subCadenceToEnum(sub.cadence);
      const key = `${sub.normalizedName}_${cadence}`;
      if (seen.has(key)) continue;
      seen.add(key);
      recurringItems.push({ id: `sub_${sub.id}`, name: sub.merchantName, type: 'expense',
        amount: round2(Number(sub.amount)), cadence, nextExpectedDate: sub.nextExpectedDate ?? null,
        confidence: 1.0, category: sub.category ?? null });
    }

    const typeMap: Record<string, 'income' | 'expense' | 'transfer'> = {
      income: 'income', expense: 'expense', transfer: 'transfer',
      settlement: 'transfer', debt_payment: 'expense', savings: 'income',
    };
    for (const ev of plannedEvents) {
      const cadence = parseCadence(ev.recurrenceRule);
      const key = `${ev.name.toLowerCase()}_${cadence}`;
      if (seen.has(key)) continue;
      seen.add(key);
      recurringItems.push({ id: `ev_${ev.id}`, name: ev.name,
        type: typeMap[ev.type] ?? 'expense', amount: round2(Math.abs(Number(ev.amount))),
        cadence, nextExpectedDate: ev.expectedDate ?? null, confidence: 1.0, category: null });
    }

    for (const item of detectedItems) {
      const key = `${item.merchant.toLowerCase()}_${item.cadence}`;
      if (seen.has(key)) continue;
      seen.add(key);
      recurringItems.push({ id: `det_${Buffer.from(item.merchant).toString('base64')}_${item.cadence}`,
        name: item.merchant, type: 'expense', amount: round2(Math.abs(item.avgAmount)),
        cadence: item.cadence, nextExpectedDate: item.nextExpected,
        confidence: Math.min(1, Math.max(0, item.amountStability)), category: item.category ?? null });
    }

    res.json({ recurringItems });
  } catch (e) { next(e); }
});

// ── /tax ──────────────────────────────────────────────────────────────────────

router.get('/tax', async (req, res, next) => {
  try {
    const householdId = req.reportingAuth!.household.id;
    const currentYear = new Date().getFullYear();
    const rawYear = parseInt(String(req.query.year ?? currentYear), 10);
    const year = Number.isFinite(rawYear) ? rawYear : currentYear;

    const accounts = await resolveHouseholdAccounts(householdId);
    const accountIds = accounts.map((a) => a.id);
    const availableCurrencies = await resolveAvailableCurrencies(accountIds);
    const { currency, err } = await resolveCurrency(
      req as unknown as { query: Record<string, unknown> },
      availableCurrencies,
    );
    if (err) { res.status(400).json({ error: err }); return; }

    const yearStart = `${year}-01-01`;
    const yearEnd = `${year}-12-31`;

    const [incomeTxns, corpEntity, setting] = await Promise.all([
      accountIds.length === 0 ? Promise.resolve([]) : Transaction.findAll({
        where: { accountId: { [Op.in]: accountIds }, currency, date: { [Op.gte]: yearStart, [Op.lte]: yearEnd }, amount: { [Op.gt]: 0 } },
        attributes: ['amount'],
      }),
      Entity.findOne({ where: { householdId, kind: 'corp' } }),
      TaxReserveSetting.findOne({ where: { householdId, currency } }),
    ]);

    const grossIncome = round2(incomeTxns.reduce((s, t) => s + Number(t.amount), 0));
    const reservePercent = Number(setting?.reservePercent ?? DEFAULT_TAX_RESERVE_PERCENT);
    const taxReserveTarget = round2(grossIncome * reservePercent);
    const taxReserveActual = 0;
    const estimatedTaxOwed = taxReserveTarget;
    const reserveDelta = round2(taxReserveTarget - taxReserveActual);

    const response: Record<string, unknown> = { year, grossIncome, estimatedTaxOwed, taxReserveTarget, taxReserveActual, reserveDelta };
    if (corpEntity) {
      response.hstCollected = null;
      response.hstRemitted = null;
      response.corporateCash = null;
    }

    res.json(response);
  } catch (e) { next(e); }
});

// ── /events ───────────────────────────────────────────────────────────────────

const LARGE_PURCHASE_THRESHOLD = 500;

router.get('/events', async (req, res, next) => {
  try {
    const householdId = req.reportingAuth!.household.id;
    const today = todayIso();
    const start = String(req.query.start ?? monthsAgoIso(3));
    const end = String(req.query.end ?? today);
    const rawLimit = parseInt(String(req.query.limit ?? '50'), 10);
    const limit = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 50, 200);

    const accounts = await resolveHouseholdAccounts(householdId);
    const accountIds = accounts.map((a) => a.id);

    type EventEntry = {
      id: string; date: string;
      type: 'large_purchase' | 'income_received' | 'subscription_started' | 'subscription_cancelled';
      title: string; amount: number | null; metadata: Record<string, unknown> | null;
    };
    const events: EventEntry[] = [];

    const [incomeEvents, subs] = await Promise.all([
      PlannedEvent.findAll({
        where: { householdId, type: 'income', status: 'posted', expectedDate: { [Op.gte]: start, [Op.lte]: end } },
        order: [['expectedDate', 'DESC']],
      }),
      Subscription.findAll({
        where: { householdId },
        order: [['updatedAt', 'DESC']],
      }),
    ]);

    if (accountIds.length > 0) {
      const largePurchases = await Transaction.findAll({
        where: { accountId: { [Op.in]: accountIds }, date: { [Op.gte]: start, [Op.lte]: end }, amount: { [Op.lte]: -LARGE_PURCHASE_THRESHOLD } },
        include: [{ model: TransactionLargePurchaseReview, as: 'largePurchaseReview', required: true }],
        order: [['date', 'DESC']],
      });
      for (const txn of largePurchases) {
        events.push({ id: `large_purchase_${txn.id}`, date: txn.date, type: 'large_purchase',
          title: (txn.merchantClean ?? txn.merchantRaw) || 'Large Purchase',
          amount: round2(Math.abs(Number(txn.amount))), metadata: null });
      }
    }

    for (const ev of incomeEvents) {
      events.push({ id: `income_received_${ev.id}`, date: ev.expectedDate, type: 'income_received',
        title: ev.name, amount: round2(Math.abs(Number(ev.amount))), metadata: null });
    }

    for (const sub of subs) {
      if (sub.status === 'active') {
        const d = sub.createdAt.toISOString().slice(0, 10);
        if (d >= start && d <= end) {
          events.push({ id: `sub_started_${sub.id}`, date: d, type: 'subscription_started',
            title: sub.merchantName, amount: round2(Number(sub.amount)), metadata: null });
        }
      } else if (sub.status === 'cancelled') {
        const d = sub.updatedAt.toISOString().slice(0, 10);
        if (d >= start && d <= end) {
          events.push({ id: `sub_cancelled_${sub.id}`, date: d, type: 'subscription_cancelled',
            title: sub.merchantName, amount: round2(Number(sub.amount)), metadata: null });
        }
      }
    }

    events.sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
    res.json({ events: events.slice(0, limit) });
  } catch (e) { next(e); }
});

export default router;
