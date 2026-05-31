import { Router } from 'express';
import { Op } from 'sequelize';
import { Account, Transaction, TaxReserveSetting, Label } from '../models';
import { DEFAULT_TAX_RESERVE_PERCENT } from '../models/TaxReserveSetting';
import { balanceAtDate } from '../networth/balanceAtDate';
import { buildSeries, monthEndDatesInRange, daysInRange } from '../networth/aggregate';
import { num } from '../util/numbers';

const router = Router();

const LIQUID_ACCOUNT_TYPES = new Set(['checking', 'savings', 'cash']);
const INVESTMENT_ACCOUNT_TYPES = new Set(['investment']);

// Maps internal accountType values to the contract's four canonical types.
function mapAccountType(raw: string | null): 'cash' | 'credit_card' | 'investment' | 'loan' {
  if (raw === 'credit_card') return 'credit_card';
  if (raw === 'investment') return 'investment';
  if (raw === 'loan') return 'loan';
  return 'cash';
}

router.get('/summary', async (req, res, next) => {
  try {
    const { household } = req.reportingAuth!;
    const asOf = new Date().toISOString();
    const today = asOf.slice(0, 10);

    const requestedCurrency = req.query.currency
      ? String(req.query.currency).toUpperCase().slice(0, 3)
      : null;

    const accounts = await Account.findAll({
      where: { householdId: household.id, closedAt: { [Op.is]: null } },
      attributes: ['id', 'accountType', 'defaultCurrency', 'openingBalance', 'openingBalanceDate', 'closedAt'],
    });

    type BalEntry = { accountType: string; currency: string; amount: number };
    const balEntries: BalEntry[] = [];
    await Promise.all(
      accounts.map(async (acc) => {
        const bals = await balanceAtDate(acc, today);
        for (const { currency, amount } of bals) {
          balEntries.push({ accountType: acc.accountType ?? 'checking', currency, amount });
        }
      }),
    );

    const availableCurrencies = new Set(balEntries.map((e) => e.currency));
    const currency = requestedCurrency ?? 'CAD';
    if (requestedCurrency && !availableCurrencies.has(requestedCurrency)) {
      res.status(400).json({ error: `No data for currency ${requestedCurrency}` });
      return;
    }

    const forCurrency = balEntries.filter((e) => e.currency === currency);
    const netWorth = round2(forCurrency.reduce((s, e) => s + e.amount, 0));
    const liquidCash = round2(
      forCurrency
        .filter((e) => LIQUID_ACCOUNT_TYPES.has(e.accountType))
        .reduce((s, e) => s + e.amount, 0),
    );

    const threeMonthsAgo = new Date();
    threeMonthsAgo.setDate(threeMonthsAgo.getDate() - 90);
    const fromDate = threeMonthsAgo.toISOString().slice(0, 10);

    const txns = await Transaction.findAll({
      where: {
        householdId: household.id,
        currency,
        date: { [Op.gte]: fromDate, [Op.lte]: today },
      },
      attributes: ['amount', 'txnType'],
      raw: true,
    });

    let totalSpend = 0;
    let totalIncome = 0;
    for (const t of txns as unknown as { amount: unknown; txnType: string | null }[]) {
      const amount = num(t.amount);
      if (amount == null) continue;
      if (amount < 0) {
        totalSpend += Math.abs(amount);
      } else if (t.txnType !== 'payment' && t.txnType !== 'transfer') {
        totalIncome += amount;
      }
    }

    const months = 3;
    const monthlyBurn = round2(totalSpend / months);
    const monthlyIncome = round2(totalIncome / months);
    const monthlySavingsRate =
      monthlyIncome > 0 ? round4((monthlyIncome - monthlyBurn) / monthlyIncome) : 0;
    const runwayMonths = monthlyBurn > 0 ? round2(liquidCash / monthlyBurn) : null;

    const reserveSetting = await TaxReserveSetting.findOne({
      where: { householdId: household.id, currency },
    });
    const reservePercent = reserveSetting
      ? Number(reserveSetting.reservePercent)
      : Number(DEFAULT_TAX_RESERVE_PERCENT);
    const taxReserveRequired = round2(monthlyIncome * months * reservePercent);
    const taxReserveActual = 0;

    res.json({
      asOf,
      currency,
      netWorth,
      liquidCash,
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

router.get('/net-worth', async (req, res, next) => {
  try {
    const { household } = req.reportingAuth!;
    const today = new Date().toISOString().slice(0, 10);
    const start = req.query.start ? String(req.query.start) : (() => {
      const d = new Date(); d.setFullYear(d.getFullYear() - 1); return d.toISOString().slice(0, 10);
    })();
    const end = req.query.end ? String(req.query.end) : today;
    const intervalRaw = req.query.interval ? String(req.query.interval) : 'month';
    if (!['day', 'week', 'month'].includes(intervalRaw)) {
      res.status(400).json({ error: 'interval must be day|week|month' });
      return;
    }
    const interval = intervalRaw as 'day' | 'week' | 'month';

    const accounts = await Account.findAll({
      where: { householdId: household.id },
      attributes: ['id'],
    });
    const accountIds = accounts.map((a) => a.id);

    let bucketDates: string[];
    if (interval === 'month') {
      bucketDates = monthEndDatesInRange(start, end);
    } else if (interval === 'day') {
      bucketDates = daysInRange(start, end);
    } else {
      // week: compute daily range, pick last day of each ISO week
      const allDays = daysInRange(start, end);
      const byWeek = new Map<string, string>();
      for (const d of allDays) {
        const dt = new Date(`${d}T00:00:00Z`);
        const year = dt.getUTCFullYear();
        // ISO week number
        const jan4 = new Date(Date.UTC(year, 0, 4));
        const weekNum = Math.ceil(
          ((dt.getTime() - jan4.getTime()) / 86400000 + jan4.getUTCDay() + 1) / 7,
        );
        const key = `${year}-W${String(weekNum).padStart(2, '0')}`;
        byWeek.set(key, d);
      }
      bucketDates = Array.from(byWeek.values()).sort();
    }

    const series = await buildSeries(start, end, interval === 'month' ? 'monthly' : 'daily', accountIds);

    // Build a lookup from date → point
    const pointMap = new Map(series.points.map((p) => [p.date, p]));
    const points = bucketDates.map((date) => {
      const p = pointMap.get(date);
      return {
        date,
        assets: p?.assetsTotal ?? 0,
        liabilities: p ? Math.abs(p.liabilitiesTotal) : 0,
        netWorth: p?.total ?? 0,
      };
    });

    res.json({ range: { start, end }, points });
  } catch (e) {
    next(e);
  }
});

router.get('/accounts', async (req, res, next) => {
  try {
    const { household } = req.reportingAuth!;
    const today = new Date().toISOString().slice(0, 10);
    const currencyFilter = req.query.currency
      ? String(req.query.currency).toUpperCase().slice(0, 3)
      : null;

    const allAccounts = await Account.findAll({
      where: { householdId: household.id, closedAt: { [Op.is]: null } },
    });

    const result = await Promise.all(
      allAccounts.map(async (acc) => {
        const bals = await balanceAtDate(acc, today);
        const currency = acc.defaultCurrency ?? 'CAD';
        const balForCurrency = bals.find((b) => b.currency === currency);
        const balance = round2(balForCurrency?.amount ?? 0);
        return {
          id: acc.id,
          name: acc.name,
          type: mapAccountType(acc.accountType),
          currency,
          balance,
          updatedAt: acc.updatedAt,
        };
      }),
    );

    const filtered = currencyFilter
      ? result.filter((a) => a.currency === currencyFilter)
      : result;

    res.json({ accounts: filtered });
  } catch (e) {
    next(e);
  }
});

router.get('/cashflow/monthly', async (req, res, next) => {
  try {
    const { household } = req.reportingAuth!;
    const today = new Date().toISOString().slice(0, 10);
    const sixMonthsAgo = new Date(); sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const start = req.query.start ? String(req.query.start) : sixMonthsAgo.toISOString().slice(0, 10);
    const end = req.query.end ? String(req.query.end) : today;
    const currencyFilter = req.query.currency
      ? String(req.query.currency).toUpperCase().slice(0, 3)
      : 'CAD';

    const txns = await Transaction.findAll({
      where: {
        householdId: household.id,
        currency: currencyFilter,
        date: { [Op.gte]: start, [Op.lte]: end },
      },
      attributes: ['date', 'amount', 'txnType', 'isRecurring'],
      raw: true,
    });

    type MonthBucket = {
      income: number;
      expenses: number;
      recurringExpenses: number;
    };
    const byMonth = new Map<string, MonthBucket>();

    for (const t of txns as unknown as { date: string; amount: unknown; txnType: string | null; isRecurring: boolean }[]) {
      const amount = num(t.amount);
      if (amount == null) continue;
      const month = t.date.slice(0, 7);
      if (!byMonth.has(month)) byMonth.set(month, { income: 0, expenses: 0, recurringExpenses: 0 });
      const bucket = byMonth.get(month)!;
      if (amount < 0) {
        const abs = Math.abs(amount);
        bucket.expenses += abs;
        if (t.isRecurring) bucket.recurringExpenses += abs;
      } else if (t.txnType !== 'payment' && t.txnType !== 'transfer') {
        bucket.income += amount;
      }
    }

    const months = Array.from(byMonth.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, b]) => {
        const income = round2(b.income);
        const expenses = round2(b.expenses);
        const recurringExpenses = round2(b.recurringExpenses);
        const variableExpenses = round2(expenses - recurringExpenses);
        const netCashflow = round2(income - expenses);
        const savingsRate = income > 0 ? round4((income - expenses) / income) : 0;
        return { month, income, expenses, netCashflow, savingsRate, recurringExpenses, variableExpenses };
      });

    res.json({ months });
  } catch (e) {
    next(e);
  }
});

router.get('/transactions', async (req, res, next) => {
  try {
    const { household } = req.reportingAuth!;

    const start = req.query.start ? String(req.query.start) : undefined;
    const end = req.query.end ? String(req.query.end) : undefined;
    const category = req.query.category ? String(req.query.category) : undefined;
    const accountIdRaw = req.query.accountId ? Number(req.query.accountId) : undefined;
    const currencyFilter = req.query.currency
      ? String(req.query.currency).toUpperCase().slice(0, 3)
      : undefined;
    const limitRaw = req.query.limit ? Math.min(Number(req.query.limit) || 50, 200) : 50;
    const limit = isNaN(limitRaw) ? 50 : limitRaw;

    let offset = 0;
    if (req.query.cursor) {
      try {
        const decoded = Buffer.from(String(req.query.cursor), 'base64').toString('utf8');
        const parsed = parseInt(decoded, 10);
        if (!Number.isFinite(parsed) || parsed < 0) throw new Error('bad');
        offset = parsed;
      } catch {
        res.status(400).json({ error: 'Invalid cursor' });
        return;
      }
    }

    const where: Record<string, unknown> = { householdId: household.id };
    if (start || end) {
      const dateCond: Record<string, string> = {};
      if (start) dateCond[Op.gte as unknown as string] = start;
      if (end) dateCond[Op.lte as unknown as string] = end;
      where.date = dateCond;
    }
    if (category) where.finalCategory = category;
    if (accountIdRaw !== undefined) where.accountId = accountIdRaw;
    if (currencyFilter) where.currency = currencyFilter;

    const rows = await Transaction.findAll({
      where,
      include: [{ model: Label, as: 'labels', attributes: ['name'], through: { attributes: [] } }],
      order: [['date', 'DESC'], ['id', 'DESC']],
      limit: limit + 1,
      offset,
    });

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);

    const transactions = page.map((t) => ({
      id: t.id,
      date: t.date,
      merchant: t.merchantClean || t.merchantRaw,
      description: t.merchantRaw,
      amount: Number(t.amount),
      currency: t.currency,
      category: t.finalCategory,
      accountId: t.accountId,
      tags: ((t as unknown as { labels: { name: string }[] }).labels ?? []).map((l) => l.name),
      isRecurring: Boolean(t.isRecurring),
    }));

    const response: Record<string, unknown> = { transactions };
    if (hasMore) {
      response.nextCursor = Buffer.from(String(offset + limit)).toString('base64');
    }
    res.json(response);
  } catch (e) {
    next(e);
  }
});

router.get('/projections', async (req, res, next) => {
  try {
    const { household } = req.reportingAuth!;
    const today = new Date().toISOString().slice(0, 10);
    const currency = req.query.currency
      ? String(req.query.currency).toUpperCase().slice(0, 3)
      : 'CAD';

    // Trailing 90-day averages for assumptions.
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setDate(threeMonthsAgo.getDate() - 90);
    const fromDate = threeMonthsAgo.toISOString().slice(0, 10);

    const txns = await Transaction.findAll({
      where: {
        householdId: household.id,
        currency,
        date: { [Op.gte]: fromDate, [Op.lte]: today },
      },
      attributes: ['amount', 'txnType'],
      raw: true,
    });

    let totalSpend = 0;
    let totalIncome = 0;
    for (const t of txns as unknown as { amount: unknown; txnType: string | null }[]) {
      const amount = num(t.amount);
      if (amount == null) continue;
      if (amount < 0) totalSpend += Math.abs(amount);
      else if (t.txnType !== 'payment' && t.txnType !== 'transfer') totalIncome += amount;
    }
    const months = 3;
    const monthlyIncome = round2(totalIncome / months);
    const monthlyExpenses = round2(totalSpend / months);

    // Tax rate from TaxReserveSetting.
    const reserveSetting = await TaxReserveSetting.findOne({
      where: { householdId: household.id, currency },
    });
    const taxRate = reserveSetting
      ? round4(Number(reserveSetting.reservePercent))
      : round4(Number(DEFAULT_TAX_RESERVE_PERCENT));

    // Current balances.
    const accounts = await Account.findAll({
      where: { householdId: household.id, closedAt: { [Op.is]: null } },
    });

    let liquidCash = 0;
    let investmentValue = 0;
    let liabilities = 0;
    await Promise.all(
      accounts.map(async (acc) => {
        const bals = await balanceAtDate(acc, today);
        for (const { currency: c, amount } of bals) {
          if (c !== currency) continue;
          const type = acc.accountType ?? 'checking';
          if (LIQUID_ACCOUNT_TYPES.has(type)) liquidCash += amount;
          else if (INVESTMENT_ACCOUNT_TYPES.has(type)) investmentValue += Math.max(0, amount);
          else if (amount < 0) liabilities += Math.abs(amount);
        }
      }),
    );

    const netMonthlyCashflow = monthlyIncome - monthlyExpenses;
    const projectedInvestments = round2(investmentValue);

    // Project 90 days forward, daily.
    const projections: { date: string; projectedNetWorth: number; projectedCash: number; projectedInvestments: number }[] = [];
    const dailyCashflow = netMonthlyCashflow / 30;
    let currentCash = liquidCash;
    const cursor = new Date(`${today}T00:00:00Z`);
    const endDate = new Date(cursor);
    endDate.setDate(endDate.getDate() + 90);

    while (cursor <= endDate) {
      const date = cursor.toISOString().slice(0, 10);
      const projectedCash = round2(currentCash);
      const projectedNetWorth = round2(projectedCash + projectedInvestments - liabilities);
      projections.push({ date, projectedNetWorth, projectedCash, projectedInvestments });
      currentCash += dailyCashflow;
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    res.json({
      assumptions: {
        monthlyIncome,
        monthlyExpenses,
        investmentGrowthRate: 0,
        taxRate,
      },
      projections,
    });
  } catch (e) {
    next(e);
  }
});

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export default router;
