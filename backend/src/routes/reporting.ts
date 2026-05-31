import { Router } from 'express';
import { Op } from 'sequelize';
import { Account, Transaction, TaxReserveSetting } from '../models';
import { DEFAULT_TAX_RESERVE_PERCENT } from '../models/TaxReserveSetting';
import { balanceAtDate } from '../networth/balanceAtDate';
import { num } from '../util/numbers';

const router = Router();

const LIQUID_ACCOUNT_TYPES = new Set(['checking', 'savings', 'cash']);

router.get('/summary', async (req, res, next) => {
  try {
    const { household } = req.reportingAuth!;
    const asOf = new Date().toISOString();
    const today = asOf.slice(0, 10);

    // Determine requested currency; default to CAD.
    const requestedCurrency = req.query.currency
      ? String(req.query.currency).toUpperCase().slice(0, 3)
      : null;

    // Load all active accounts for the household.
    const accounts = await Account.findAll({
      where: { householdId: household.id, closedAt: { [Op.is]: null } },
      attributes: ['id', 'accountType', 'defaultCurrency', 'openingBalance', 'openingBalanceDate', 'closedAt'],
    });

    // Compute per-account balances.
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

    // Collect distinct currencies.
    const availableCurrencies = new Set(balEntries.map((e) => e.currency));

    // If an explicit currency was requested and we have no data for it, 400.
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

    // Monthly burn / income: average over the last 3 months of transactions.
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

    // Tax reserve from TaxReserveSetting.
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

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export default router;
