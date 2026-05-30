import { Router } from 'express';
import { Op } from 'sequelize';
import { Account, Transaction, TaxReserveSetting } from '../models';
import { balanceAtDate } from '../networth/balanceAtDate';
import { DEFAULT_TAX_RESERVE_PERCENT } from '../models/TaxReserveSetting';

const router = Router();

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function monthsAgoIso(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 10);
}

router.get('/summary', async (req, res, next) => {
  try {
    const { household } = req.reportingAuth!;
    const householdId = household.id;

    // Currency selection
    const accounts = await Account.findAll({
      where: {
        householdId,
        [Op.or]: [{ visibility: 'shared' }, { ownerUserId: req.reportingAuth!.user.id }],
      },
    });

    // Determine available currencies from transactions (last 12 months)
    const twelveMonthsAgo = monthsAgoIso(12);
    const accountIds = accounts.map((a) => a.id);
    const currenciesInData = accountIds.length === 0
      ? []
      : await Transaction.findAll({
          where: {
            accountId: { [Op.in]: accountIds },
            date: { [Op.gte]: twelveMonthsAgo },
          },
          attributes: ['currency'],
          group: ['currency'],
        });

    const availableCurrencies = new Set(currenciesInData.map((t) => t.currency));

    // Determine requested currency
    let currency = ((req.query.currency as string | undefined) ?? '').toUpperCase().slice(0, 3);
    if (!currency) {
      // Default: household base currency derived from most-common transaction currency
      // or CAD fallback
      currency = availableCurrencies.has('CAD')
        ? 'CAD'
        : availableCurrencies.size > 0
          ? Array.from(availableCurrencies)[0]
          : 'CAD';
    }

    if (availableCurrencies.size > 0 && !availableCurrencies.has(currency)) {
      res.status(400).json({ error: `No data for currency ${currency}` });
      return;
    }

    const asOf = todayIso();
    const sixMonthsAgo = monthsAgoIso(6);

    // Monthly metrics over last 6 months
    const recentTxns =
      accountIds.length === 0
        ? []
        : await Transaction.findAll({
            where: {
              accountId: { [Op.in]: accountIds },
              currency,
              date: { [Op.gte]: sixMonthsAgo, [Op.lte]: asOf },
            },
            attributes: ['amount', 'date', 'txnType'],
          });

    // Aggregate spend and income by month
    const monthlySpend = new Map<string, number>();
    const monthlyIncome = new Map<string, number>();
    for (const txn of recentTxns) {
      const month = txn.date.slice(0, 7);
      const amount = Number(txn.amount);
      if (amount < 0) {
        monthlySpend.set(month, (monthlySpend.get(month) ?? 0) + -amount);
      } else if (amount > 0) {
        monthlyIncome.set(month, (monthlyIncome.get(month) ?? 0) + amount);
      }
    }

    // Average over months that have data (at most 6)
    const spendValues = Array.from(monthlySpend.values());
    const incomeValues = Array.from(monthlyIncome.values());
    const monthlyBurn =
      spendValues.length > 0
        ? spendValues.reduce((a, b) => a + b, 0) / Math.max(spendValues.length, 1)
        : 0;
    const monthlyIncomeAvg =
      incomeValues.length > 0
        ? incomeValues.reduce((a, b) => a + b, 0) / Math.max(incomeValues.length, 1)
        : 0;

    const monthlySavingsRate =
      monthlyIncomeAvg > 0
        ? Math.max(0, Math.min(1, (monthlyIncomeAvg - monthlyBurn) / monthlyIncomeAvg))
        : 0;

    // Net worth and liquid cash: sum account balances in the selected currency
    let netWorth = 0;
    let liquidCash = 0;
    const LIQUID_TYPES = new Set(['checking', 'savings', 'cash']);
    for (const account of accounts) {
      const balances = await balanceAtDate(account, asOf);
      for (const b of balances) {
        if (b.currency !== currency) continue;
        netWorth += b.amount;
        if (LIQUID_TYPES.has(account.accountType ?? '')) {
          liquidCash += b.amount;
        }
      }
    }

    const runwayMonths = monthlyBurn > 0 ? Math.max(0, liquidCash / monthlyBurn) : null;

    // Tax reserve
    const setting = await TaxReserveSetting.findOne({
      where: { householdId, currency },
    });
    const reservePercent = Number(setting?.reservePercent ?? DEFAULT_TAX_RESERVE_PERCENT);
    // Required = reservePercent of annualized income
    const annualIncome = monthlyIncomeAvg * 12;
    const taxReserveRequired = Math.round(annualIncome * reservePercent * 100) / 100;
    // Actual = best-effort 0; no dedicated "tax reserve account" concept yet
    const taxReserveActual = 0;

    res.json({
      asOf: new Date().toISOString(),
      currency,
      netWorth: Math.round(netWorth * 100) / 100,
      liquidCash: Math.round(liquidCash * 100) / 100,
      monthlyBurn: Math.round(monthlyBurn * 100) / 100,
      monthlyIncome: Math.round(monthlyIncomeAvg * 100) / 100,
      monthlySavingsRate: Math.round(monthlySavingsRate * 10000) / 10000,
      runwayMonths: runwayMonths !== null ? Math.round(runwayMonths * 100) / 100 : null,
      taxReserveRequired: Math.round(taxReserveRequired * 100) / 100,
      taxReserveActual,
    });
  } catch (e) {
    next(e);
  }
});

export default router;
