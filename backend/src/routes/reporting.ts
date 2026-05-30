import { Router } from 'express';
import { Op } from 'sequelize';
import { Account, Transaction, TaxReserveSetting } from '../models';
import { balanceAtDate } from '../networth/balanceAtDate';
import { DEFAULT_TAX_RESERVE_PERCENT } from '../models/TaxReserveSetting';
import { buildNetWorthAt, buildSeries, daysInRange } from '../networth/aggregate';
import { buildForecast } from '../forecast/buildForecast';

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

export default router;
