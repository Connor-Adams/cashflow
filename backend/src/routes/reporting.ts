import { Router } from 'express';
import { Op } from 'sequelize';
import { Account, Transaction, TaxReserveSetting, Label, PlannedEvent, FinanceEvent } from '../models';
import { DEFAULT_TAX_RESERVE_PERCENT } from '../models/TaxReserveSetting';
import { serializeSubscription } from '../expectations/subscriptionMapper';
import { balanceAtDate } from '../networth/balanceAtDate';
import {
  buildSeries,
  monthEndDatesInRange,
  daysInRange,
  PORTFOLIO_DRIVEN_TYPES,
} from '../networth/aggregate';
import { portfolioMarketValueAt } from '../networth/portfolioMarketValueAt';
import { detectRecurring, type RecurringInputTxn } from './recurring';
import { num } from '../util/numbers';
import { isNonSpend } from '../summary/classifyTransactionFlow';
import { summarizeReportingCashflow } from '../reporting/cashflowTotals';

// Categories considered essential for runway calculation.
const ESSENTIAL_CATEGORIES = new Set([
  'housing', 'rent', 'mortgage', 'utilities', 'groceries', 'insurance',
  'transport', 'transportation', 'healthcare', 'health', 'debt',
  'internet', 'phone', 'hydro', 'electricity', 'water', 'gas',
]);

const router = Router();

const LIQUID_ACCOUNT_TYPES = new Set(['checking', 'savings', 'cash']);

/**
 * Accounts whose holdings (not txn stream) drive value — only their ids may
 * be passed to portfolioMarketValueAt. Mirrors networth/aggregate's
 * buildNetWorthAt: holdings on a mistyped non-investment account must not
 * count on top of that account's txn-stream balance.
 */
function portfolioAccountIds(accounts: Array<{ id: number; accountType: string | null }>): number[] {
  return accounts
    .filter((a) => PORTFOLIO_DRIVEN_TYPES.has(a.accountType ?? ''))
    .map((a) => a.id);
}

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
        // Investment accounts are portfolio-driven: their txn stream (buys,
        // transfers, dividends) doesn't sum to a meaningful balance. Holdings
        // market value is added below instead — mirrors networth/aggregate's
        // PORTFOLIO_DRIVEN_TYPES skip so this netWorth agrees with /net-worth.
        if (PORTFOLIO_DRIVEN_TYPES.has(acc.accountType ?? '')) return;
        const bals = await balanceAtDate(acc, today);
        for (const { currency, amount } of bals) {
          balEntries.push({ accountType: acc.accountType ?? 'checking', currency, amount });
        }
      }),
    );
    const portfolio = await portfolioMarketValueAt(today, portfolioAccountIds(accounts));
    for (const row of portfolio.rows) {
      balEntries.push({ accountType: 'investment', currency: row.currency, amount: row.marketValue });
    }

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

    const rawTxnRows = await Transaction.findAll({
      where: {
        householdId: household.id,
        currency,
        date: { [Op.gte]: fromDate, [Op.lte]: today },
      },
      attributes: ['amount', 'txnType'],
      include: [{ association: 'account', attributes: ['accountType'] }],
      raw: true,
    });

    const summaryTxns = (rawTxnRows as unknown as Array<Record<string, unknown>>).map((t) => ({
      amount: t.amount,
      txnType: t.txnType as string | null,
      accountType: (t['account.accountType'] ?? null) as string | null,
    }));
    const { totalSpend, totalIncome } = summarizeReportingCashflow(summaryTxns);

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
      // week: group days by their ISO-8601 week (Monday-start) and pick the
      // last in-range day of each. Keying on the week's Monday date is stable
      // across the year boundary — the old ceil-based week number put early-
      // January days in a bogus week 0 and split weeks at Saturday.
      const allDays = daysInRange(start, end);
      const byWeek = new Map<string, string>();
      for (const d of allDays) {
        byWeek.set(isoWeekStart(d), d);
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
      include: [{ association: 'account', attributes: ['accountType'] }],
      raw: true,
    });

    type MonthBucket = {
      income: number;
      expenses: number;
      recurringExpenses: number;
    };
    const byMonth = new Map<string, MonthBucket>();

    for (const t of txns as unknown as { date: string; amount: unknown; txnType: string | null; isRecurring: boolean; 'account.accountType': string | null }[]) {
      const amount = num(t.amount);
      if (amount == null) continue;
      const month = t.date.slice(0, 7);
      if (!byMonth.has(month)) byMonth.set(month, { income: 0, expenses: 0, recurringExpenses: 0 });
      const bucket = byMonth.get(month)!;
      if (amount < 0) {
        // Exclude money-movement (transfers, investment buys, statement
        // payments, refunds-reversals, anything on an investment account)
        // from expenses — same rule as the dashboard's isNonSpend, so
        // monthly burn reconciles.
        if (isNonSpend(t.txnType, t['account.accountType'] ?? null)) continue;
        const abs = Math.abs(amount);
        bucket.expenses += abs;
        if (t.isRecurring) bucket.recurringExpenses += abs;
      } else if (t.txnType === 'income') {
        // Income peel: only real income inflates the income line. Refunds,
        // rewards, and untyped deposits are NOT income (previously every
        // positive non-payment/transfer bled in, inflating savings rate).
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

    const rawProjRows = await Transaction.findAll({
      where: {
        householdId: household.id,
        currency,
        date: { [Op.gte]: fromDate, [Op.lte]: today },
      },
      attributes: ['amount', 'txnType'],
      include: [{ association: 'account', attributes: ['accountType'] }],
      raw: true,
    });

    const projTxns = (rawProjRows as unknown as Array<Record<string, unknown>>).map((t) => ({
      amount: t.amount,
      txnType: t.txnType as string | null,
      accountType: (t['account.accountType'] ?? null) as string | null,
    }));
    const { totalSpend, totalIncome } = summarizeReportingCashflow(projTxns);
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
        const type = acc.accountType ?? 'checking';
        // Investment accounts contribute holdings market value (below) —
        // their txn-stream balance is a meaningless buy/transfer residual.
        if (PORTFOLIO_DRIVEN_TYPES.has(type)) return;
        const bals = await balanceAtDate(acc, today);
        for (const { currency: c, amount } of bals) {
          if (c !== currency) continue;
          if (LIQUID_ACCOUNT_TYPES.has(type)) liquidCash += amount;
          else if (amount < 0) liabilities += Math.abs(amount);
        }
      }),
    );
    const projPortfolio = await portfolioMarketValueAt(today, portfolioAccountIds(accounts));
    for (const row of projPortfolio.rows) {
      if (row.currency === currency) investmentValue += row.marketValue;
    }

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

// ── GET /api/v1/runway ────────────────────────────────────────────────────────
router.get('/runway', async (req, res, next) => {
  try {
    const { household } = req.reportingAuth!;
    const today = new Date().toISOString().slice(0, 10);
    const currency = req.query.currency
      ? String(req.query.currency).toUpperCase().slice(0, 3)
      : 'CAD';

    const threeMonthsAgo = new Date();
    threeMonthsAgo.setDate(threeMonthsAgo.getDate() - 90);
    const fromDate = threeMonthsAgo.toISOString().slice(0, 10);

    const rawRunwayRows = await Transaction.findAll({
      where: {
        householdId: household.id,
        currency,
        date: { [Op.gte]: fromDate, [Op.lte]: today },
      },
      attributes: ['amount', 'txnType', 'finalCategory', 'finalCategoryId'], // B2: finalCategoryId selected for future rollup
      include: [{ association: 'account', attributes: ['accountType'] }],
      raw: true,
    });

    const runwayTxns = (rawRunwayRows as unknown as Array<Record<string, unknown>>).map((t) => ({
      amount: t.amount,
      txnType: t.txnType as string | null,
      finalCategory: (t.finalCategory ?? null) as string | null,
      accountType: (t['account.accountType'] ?? null) as string | null,
    }));
    const { totalSpend, essentialSpend } = summarizeReportingCashflow(
      runwayTxns,
      ESSENTIAL_CATEGORIES,
    );

    const months = 3;
    const averageMonthlyBurn = round2(totalSpend / months);
    const essentialMonthlyBurn = round2(essentialSpend / months);
    const lifestyleMonthlyBurn = round2(averageMonthlyBurn - essentialMonthlyBurn);

    const accounts = await Account.findAll({
      where: { householdId: household.id, closedAt: { [Op.is]: null } },
    });
    let liquidCash = 0;
    await Promise.all(
      accounts.map(async (acc) => {
        if (!LIQUID_ACCOUNT_TYPES.has(acc.accountType ?? '')) return;
        const bals = await balanceAtDate(acc, today);
        for (const { currency: c, amount } of bals) {
          if (c === currency) liquidCash += amount;
        }
      }),
    );
    liquidCash = round2(liquidCash);

    const runwayMonths = averageMonthlyBurn > 0 ? round2(liquidCash / averageMonthlyBurn) : null;
    const conservativeRunwayMonths = essentialMonthlyBurn > 0 ? round2(liquidCash / essentialMonthlyBurn) : null;

    res.json({
      liquidCash,
      averageMonthlyBurn,
      essentialMonthlyBurn,
      lifestyleMonthlyBurn,
      runwayMonths,
      conservativeRunwayMonths,
    });
  } catch (e) {
    next(e);
  }
});

// ── GET /api/v1/spending/by-category ─────────────────────────────────────────
router.get('/spending/by-category', async (req, res, next) => {
  try {
    const { household } = req.reportingAuth!;
    const currency = req.query.currency
      ? String(req.query.currency).toUpperCase().slice(0, 3)
      : 'CAD';

    const today = new Date().toISOString().slice(0, 10);
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const defaultStart = thirtyDaysAgo.toISOString().slice(0, 10);

    const start = req.query.start ? String(req.query.start).slice(0, 10) : defaultStart;
    const end = req.query.end ? String(req.query.end).slice(0, 10) : today;

    // Compute equal-length previous period for trend.
    const startMs = new Date(start).getTime();
    const endMs = new Date(end).getTime();
    const periodMs = endMs - startMs;
    const prevEnd = new Date(startMs - 1).toISOString().slice(0, 10);
    const prevStart = new Date(startMs - periodMs - 1).toISOString().slice(0, 10);

    const [currTxns, prevTxns] = await Promise.all([
      Transaction.findAll({
        where: {
          householdId: household.id,
          currency,
          date: { [Op.gte]: start, [Op.lte]: end },
          amount: { [Op.lt]: 0 },
        },
        attributes: ['amount', 'finalCategory', 'finalCategoryId', 'txnType'], // B2: finalCategoryId selected for future rollup
        include: [{ association: 'account', attributes: ['accountType'] }],
        raw: true,
      }),
      Transaction.findAll({
        where: {
          householdId: household.id,
          currency,
          date: { [Op.gte]: prevStart, [Op.lte]: prevEnd },
          amount: { [Op.lt]: 0 },
        },
        attributes: ['amount', 'finalCategory', 'finalCategoryId', 'txnType'], // B2: finalCategoryId selected for future rollup
        include: [{ association: 'account', attributes: ['accountType'] }],
        raw: true,
      }),
    ]);

    // accountType rides along so isNonSpend can drop unrecognized brokerage
    // debits (txnType defaults to 'purchase') — same rule as the dashboard.
    type Row = { amount: unknown; finalCategory: string | null; txnType: string | null; 'account.accountType': string | null };
    const currMap = new Map<string, { amount: number; count: number }>();
    for (const t of currTxns as unknown as Row[]) {
      if (isNonSpend(t.txnType, t['account.accountType'] ?? null)) continue;
      const a = num(t.amount);
      if (a == null) continue;
      const cat = t.finalCategory ?? 'Uncategorized';
      const existing = currMap.get(cat) ?? { amount: 0, count: 0 };
      existing.amount += Math.abs(a);
      existing.count += 1;
      currMap.set(cat, existing);
    }

    const prevMap = new Map<string, number>();
    for (const t of prevTxns as unknown as Row[]) {
      if (isNonSpend(t.txnType, t['account.accountType'] ?? null)) continue;
      const a = num(t.amount);
      if (a == null) continue;
      const cat = t.finalCategory ?? 'Uncategorized';
      prevMap.set(cat, (prevMap.get(cat) ?? 0) + Math.abs(a));
    }

    const totalAmount = Array.from(currMap.values()).reduce((s, v) => s + v.amount, 0);
    const categories = Array.from(currMap.entries()).map(([name, { amount, count }]) => {
      const percentage = totalAmount > 0 ? round4(amount / totalAmount) : 0;
      const prevAmount = prevMap.get(name) ?? 0;
      const trendVsPreviousPeriod = prevAmount > 0 ? round4((amount - prevAmount) / prevAmount) : null;
      return {
        categoryId: name,
        name,
        amount: round2(amount),
        percentage,
        transactionCount: count,
        trendVsPreviousPeriod,
      };
    });
    categories.sort((a, b) => b.amount - a.amount);

    res.json({ start, end, categories });
  } catch (e) {
    next(e);
  }
});

// ── GET /api/v1/recurring ─────────────────────────────────────────────────────
router.get('/recurring', async (req, res, next) => {
  try {
    const { household } = req.reportingAuth!;
    const currency = req.query.currency
      ? String(req.query.currency).toUpperCase().slice(0, 3)
      : null;

    // 1. Explicit Subscriptions (folded into PlannedEvent kind='subscription';
    //    legacy 'active' = {status:'planned', statusUncertain:false}). Serialize
    //    back to the legacy Subscription DTO so the consumers below read
    //    merchantName / cadence / nextExpectedDate / category unchanged.
    const subWhere: Record<string, unknown> = {
      householdId: household.id,
      kind: 'subscription',
      status: 'planned',
      statusUncertain: false,
    };
    if (currency) subWhere.currency = currency;
    const subscriptionRows = await PlannedEvent.findAll({ where: subWhere });
    const subscriptions = subscriptionRows.map((row) => serializeSubscription(row));

    // 2. Recurring PlannedEvents (have a recurrenceRule and are not skipped/ignored).
    const peWhere: Record<string, unknown> = {
      householdId: household.id,
      recurrenceRule: { [Op.ne]: null },
      status: { [Op.notIn]: ['skipped', 'ignored'] },
    };
    if (currency) peWhere.currency = currency;
    const plannedEvents = await PlannedEvent.findAll({
      where: peWhere,
      attributes: ['id', 'name', 'amount', 'currency', 'type', 'expectedDate', 'recurrenceRule'],
    });

    // 3. Inferred via detectRecurring on recent transactions.
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setDate(sixMonthsAgo.getDate() - 180);
    const fromDate = sixMonthsAgo.toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);

    const txnWhere: Record<string, unknown> = {
      householdId: household.id,
      date: { [Op.gte]: fromDate, [Op.lte]: today },
      amount: { [Op.lt]: 0 },
      txnType: { [Op.notIn]: ['payment', 'transfer', 'refund'] },
    };
    if (currency) txnWhere.currency = currency;

    const rawTxns = await Transaction.findAll({
      where: txnWhere,
      attributes: ['merchantClean', 'merchantRaw', 'amount', 'currency', 'date', 'finalCategory', 'finalCategoryId'], // B2: finalCategoryId selected for future rollup
      raw: true,
    });

    const candidates: RecurringInputTxn[] = (
      rawTxns as unknown as {
        merchantClean: string | null;
        merchantRaw: string | null;
        amount: unknown;
        currency: string;
        date: string;
        finalCategory: string | null;
      }[]
    ).map((t) => ({
      merchant: t.merchantClean || t.merchantRaw || null,
      amount: num(t.amount) ?? 0,
      currency: t.currency,
      date: t.date,
      category: t.finalCategory,
    }));

    const inferred = detectRecurring(candidates);

    // Dedupe: skip inferred items whose merchant matches an explicit subscription.
    const explicitMerchants = new Set(
      subscriptions.map((s) => s.merchantName.toLowerCase()),
    );

    const items: Array<{
      id: string;
      name: string;
      type: 'income' | 'expense' | 'transfer';
      amount: number;
      cadence: 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'annual';
      nextExpectedDate: string | null;
      confidence: number;
      category: string | null;
    }> = [];

    for (const s of subscriptions) {
      items.push({
        id: `sub-${s.id}`,
        name: s.merchantName,
        type: 'expense',
        amount: round2(Math.abs(num(s.amount) ?? 0)),
        cadence: mapCadence(s.cadence),
        nextExpectedDate: s.nextExpectedDate ?? null,
        confidence: 1.0,
        category: s.category,
      });
    }

    for (const pe of plannedEvents) {
      items.push({
        id: `pe-${pe.id}`,
        name: pe.name,
        type: pe.type === 'income' ? 'income' : 'expense',
        amount: round2(Math.abs(num(pe.amount) ?? 0)),
        cadence: parseRecurrenceCadence(pe.recurrenceRule),
        nextExpectedDate: pe.expectedDate,
        confidence: 1.0,
        category: null,
      });
    }

    for (const inf of inferred) {
      if (explicitMerchants.has(inf.merchant.toLowerCase())) continue;
      items.push({
        id: `inf-${inf.merchant}-${inf.currency}`,
        name: inf.merchant,
        type: 'expense',
        amount: round2(Math.abs(inf.avgAmount)),
        cadence: inf.cadence === 'weekly' ? 'weekly' : 'monthly',
        nextExpectedDate: inf.nextExpected,
        confidence: round4(inf.amountStability),
        category: inf.category,
      });
    }

    res.json({ recurringItems: items });
  } catch (e) {
    next(e);
  }
});

// ── GET /api/v1/tax ───────────────────────────────────────────────────────────
router.get('/tax', async (req, res, next) => {
  try {
    const { household } = req.reportingAuth!;
    const currentYear = new Date().getFullYear();
    const year = req.query.year ? Number(req.query.year) : currentYear;
    const currency = req.query.currency
      ? String(req.query.currency).toUpperCase().slice(0, 3)
      : 'CAD';

    const yearStart = `${year}-01-01`;
    const yearEnd = `${year}-12-31`;

    const txns = await Transaction.findAll({
      where: {
        householdId: household.id,
        currency,
        date: { [Op.gte]: yearStart, [Op.lte]: yearEnd },
      },
      attributes: ['amount', 'txnType'],
      raw: true,
    });

    // Same income peel as /summary: only txnType='income' rows are income.
    // Refunds, rewards, brokerage sells, and untyped deposits are not — they
    // would inflate estimatedTaxOwed with pure noise.
    const taxTxns = (txns as unknown as Array<Record<string, unknown>>).map((t) => ({
      amount: t.amount,
      txnType: t.txnType as string | null,
    }));
    const grossIncome = round2(summarizeReportingCashflow(taxTxns).totalIncome);

    const reserveSetting = await TaxReserveSetting.findOne({
      where: { householdId: household.id, currency },
    });
    const reservePercent = reserveSetting
      ? Number(reserveSetting.reservePercent)
      : Number(DEFAULT_TAX_RESERVE_PERCENT);

    const estimatedTaxOwed = round2(grossIncome * reservePercent);
    const taxReserveTarget = estimatedTaxOwed;
    const taxReserveActual = 0;
    const reserveDelta = round2(taxReserveTarget - taxReserveActual);

    res.json({
      year,
      grossIncome,
      estimatedTaxOwed,
      taxReserveTarget,
      taxReserveActual,
      reserveDelta,
    });
  } catch (e) {
    next(e);
  }
});

// ── GET /api/v1/events ────────────────────────────────────────────────────────
router.get('/events', async (req, res, next) => {
  try {
    const { household } = req.reportingAuth!;
    const today = new Date().toISOString().slice(0, 10);
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const defaultStart = thirtyDaysAgo.toISOString().slice(0, 10);

    const start = req.query.start ? String(req.query.start).slice(0, 10) : defaultStart;
    const end = req.query.end ? String(req.query.end).slice(0, 10) : today;
    const rawLimit = Number(req.query.limit ?? 50);
    const limit = Math.min(isNaN(rawLimit) ? 50 : rawLimit, 200);

    const LARGE_PURCHASE_THRESHOLD = 500;

    // Fetch sources in parallel.
    const [largePurchases, incomeEvents, subEvents] = await Promise.all([
      // large_purchase: expense transactions over threshold.
      Transaction.findAll({
        where: {
          householdId: household.id,
          date: { [Op.gte]: start, [Op.lte]: end },
          amount: { [Op.lt]: -LARGE_PURCHASE_THRESHOLD },
          txnType: { [Op.notIn]: ['payment', 'transfer', 'refund'] },
        },
        attributes: ['id', 'date', 'merchantClean', 'merchantRaw', 'amount', 'currency'],
        order: [['date', 'DESC']],
        raw: true,
      }),
      // income_received: positive non-payment/transfer transactions.
      Transaction.findAll({
        where: {
          householdId: household.id,
          date: { [Op.gte]: start, [Op.lte]: end },
          amount: { [Op.gt]: 0 },
          txnType: { [Op.notIn]: ['payment', 'transfer', 'refund'] },
        },
        attributes: ['id', 'date', 'merchantClean', 'merchantRaw', 'amount', 'currency'],
        order: [['date', 'DESC']],
        raw: true,
      }),
      // subscription lifecycle events from FinanceEvent log.
      FinanceEvent.findAll({
        where: {
          householdId: household.id,
          occurredAt: { [Op.gte]: new Date(start), [Op.lte]: new Date(end + 'T23:59:59Z') },
          type: { [Op.in]: ['subscription.created', 'subscription.cancelled'] },
        },
        order: [['occurredAt', 'DESC']],
        raw: true,
      }),
    ]);

    type TxnRow = { id: number; date: string; merchantClean: string | null; merchantRaw: string | null; amount: unknown; currency: string };
    type SubEventRow = { id: number; type: string; payload: unknown; occurredAt: Date };

    const events: Array<{
      id: string;
      date: string;
      type: string;
      title: string;
      amount?: number;
      metadata?: Record<string, unknown>;
    }> = [];

    for (const t of largePurchases as unknown as TxnRow[]) {
      const amount = Math.abs(num(t.amount) ?? 0);
      events.push({
        id: `large_purchase-${t.id}`,
        date: t.date,
        type: 'large_purchase',
        title: t.merchantClean || t.merchantRaw || 'Purchase',
        amount,
        metadata: { currency: t.currency },
      });
    }

    for (const t of incomeEvents as unknown as TxnRow[]) {
      const amount = num(t.amount) ?? 0;
      events.push({
        id: `income_received-${t.id}`,
        date: t.date,
        type: 'income_received',
        title: t.merchantClean || t.merchantRaw || 'Income',
        amount,
        metadata: { currency: t.currency },
      });
    }

    for (const e of subEvents as unknown as SubEventRow[]) {
      const type = e.type === 'subscription.created' ? 'subscription_started' : 'subscription_cancelled';
      const payload = (e.payload && typeof e.payload === 'object' ? e.payload : {}) as Record<string, unknown>;
      events.push({
        id: `${type}-${e.id}`,
        date: new Date(e.occurredAt).toISOString().slice(0, 10),
        type,
        title: String(payload.merchantName ?? payload.name ?? 'Subscription'),
        metadata: payload,
      });
    }

    events.sort((a, b) => b.date.localeCompare(a.date));
    res.json({ events: events.slice(0, limit) });
  } catch (e) {
    next(e);
  }
});

function mapCadence(
  c: string,
): 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'annual' {
  if (c === 'weekly') return 'weekly';
  if (c === 'biweekly') return 'biweekly';
  if (c === 'quarterly') return 'quarterly';
  if (c === 'annual' || c === 'yearly') return 'annual';
  return 'monthly';
}

function parseRecurrenceCadence(
  rule: string | null,
): 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'annual' {
  if (!rule) return 'monthly';
  const r = rule.toUpperCase();
  if (r.includes('FREQ=WEEKLY')) {
    const intervalMatch = r.match(/INTERVAL=(\d+)/);
    const interval = intervalMatch ? Number(intervalMatch[1]) : 1;
    return interval >= 2 ? 'biweekly' : 'weekly';
  }
  if (r.includes('FREQ=MONTHLY')) {
    const intervalMatch = r.match(/INTERVAL=(\d+)/);
    const interval = intervalMatch ? Number(intervalMatch[1]) : 1;
    return interval >= 3 ? 'quarterly' : 'monthly';
  }
  if (r.includes('FREQ=YEARLY') || r.includes('FREQ=ANNUAL')) return 'annual';
  return 'monthly';
}

/**
 * ISO-8601 week start (the Monday of the week containing `date`) as a
 * YYYY-MM-DD key. ISO weeks run Monday–Sunday, so two dates share a week iff
 * they map to the same Monday. Stable across the year boundary, unlike a
 * per-year week-number that resets to a bogus 0 in early January.
 */
function isoWeekStart(date: string): string {
  const dt = new Date(`${date}T00:00:00Z`);
  const dow = dt.getUTCDay(); // 0=Sun .. 6=Sat
  const isoDow = dow === 0 ? 7 : dow; // 1=Mon .. 7=Sun
  const monday = new Date(dt.getTime() - (isoDow - 1) * 86400000);
  return monday.toISOString().slice(0, 10);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export default router;
