import { Op } from 'sequelize';
import { accountKind } from './accountKind';
import { balanceAtDate } from './balanceAtDate';
import { portfolioMarketValueAt } from './portfolioMarketValueAt';
import {
  unifyToCad,
  type PerCurrencyByKind,
  type FxRateUsed,
  type FxLookup,
} from './unifyToCad';
import { ensureFxRate } from '../fx/bankOfCanada';
import { toUnits, fromUnits } from '../util/numbers';

// Investment accounts derive their net-worth contribution from holdings
// market value, NOT from the cash-flow transaction stream — txns on these
// accounts (buys, transfers, dividends) net out to portfolio value, and
// summing them as a balance double-counts or produces nonsense.
const PORTFOLIO_DRIVEN_TYPES = new Set(['investment']);

export type DataQualityWarning = 'asset_balance_negative';

export type BreakdownRow = {
  source: 'account' | 'portfolio';
  accountId: number | null;
  label: string;
  currency: string;
  native: number | null;
  cadValue: number | null;
  /**
   * False when the source is an account that has openingBalance === 0 AND
   * openingBalanceDate === null AND has any transactions in scope. The
   * derived balance for such accounts is suspect because we don't know the
   * starting point.
   */
  openingBalanceSet: boolean;
  /**
   * When set, this row was excluded from the per-currency totals because
   * its balance violates an invariant (e.g. asset went negative). The row
   * is still surfaced in the breakdown so the user can see + correct it.
   */
  dataQualityWarning?: DataQualityWarning;
};

export type NetWorthGap =
  | { date: string; currency: string; reason: 'fx_rate_unavailable' }
  | { date: string; currency: string; reason: 'price_unavailable'; securityId: number };

export type NetWorthAtDate = {
  asOf: string;
  baseCurrency: 'CAD';
  total: number;
  assetsTotal: number;
  liabilitiesTotal: number;
  breakdown: { assets: BreakdownRow[]; liabilities: BreakdownRow[] };
  fxRatesUsed: FxRateUsed[];
  partial: boolean;
  gaps: NetWorthGap[];
};

/**
 * Looser FX lookup than `ensureFxRate` (which caps cache lookback at 7
 * days). For historical net-worth buckets we'd rather show "approximate"
 * than emit a gap, so we walk back up to 365 days, and as a last resort
 * pick the most recent FxRate row ever for that currency pair.
 *
 * Returns null only when no FxRate row for the pair exists at all.
 */
export const looseHistoricalFxLookup: FxLookup = async (from, to, asOf) => {
  if (from === to) return { rate: 1, ratedDate: asOf };

  // Primary path: ensureFxRate handles same-day cache + fresh BoC fetch.
  const fresh = await ensureFxRate(from, to, asOf);
  if (fresh) return fresh;

  // Fallback: nearest FxRate row on/before asOf, no staleness cap.
  const { FxRate } = await import('../models');
  const past = await FxRate.findOne({
    where: { fromCurrency: from, toCurrency: to, ratedDate: { [Op.lte]: asOf } },
    order: [['ratedDate', 'DESC']],
  });
  if (past) return { rate: Number(past.rate), ratedDate: past.ratedDate };

  // Last resort: any rate for the pair, even if newer than asOf — better
  // than excluding the currency entirely from a historical snapshot.
  const any = await FxRate.findOne({
    where: { fromCurrency: from, toCurrency: to },
    order: [['ratedDate', 'DESC']],
  });
  if (any) return { rate: Number(any.rate), ratedDate: any.ratedDate };

  return null;
};

function isImplicitZeroOpening(acc: {
  openingBalance: string;
  openingBalanceDate: string | null;
}): boolean {
  return Number(acc.openingBalance) === 0 && acc.openingBalanceDate == null;
}

export async function buildNetWorthAt(
  asOf: string,
  accountIds: number[],
  fxLookup: FxLookup = looseHistoricalFxLookup
): Promise<NetWorthAtDate> {
  const assets: BreakdownRow[] = [];
  const liabilities: BreakdownRow[] = [];
  const perCurrency: PerCurrencyByKind = {};
  const gaps: NetWorthGap[] = [];

  if (accountIds.length === 0) {
    return {
      asOf,
      baseCurrency: 'CAD',
      total: 0,
      assetsTotal: 0,
      liabilitiesTotal: 0,
      breakdown: { assets, liabilities },
      fxRatesUsed: [],
      partial: false,
      gaps: [],
    };
  }

  const { Account, Transaction } = await import('../models');
  const allAccounts = await Account.findAll({ where: { id: accountIds } });
  // Closed accounts contribute zero from closed_at onward. Pre-closure
  // snapshots/txns remain intact; the account simply drops out of any
  // net-worth calc with asOf >= closed_at. Leaves the door open to
  // reopening (clear closed_at) without touching historical data.
  const accounts = allAccounts.filter(
    (a) => !a.closedAt || a.closedAt > asOf
  );

  for (const acc of accounts) {
    const kind = accountKind(acc.accountType);

    // Portfolio-driven accounts (investments): skip txn-stream balance. The
    // holdings table is authoritative for these — txns on them are buys,
    // transfers, dividends, etc. that don't accumulate into a meaningful
    // cash balance. Emit no account-source rows for these accounts.
    if (PORTFOLIO_DRIVEN_TYPES.has(acc.accountType)) continue;

    // Check if the account has any txns in scope — used only to decide
    // whether to flag "opening balance not set" on the breakdown row.
    const hasTxns =
      (await Transaction.count({
        where: { accountId: acc.id, date: { [Op.lte]: asOf } },
      })) > 0;
    const openingBalanceSet = !isImplicitZeroOpening(acc) || !hasTxns;

    const balances = await balanceAtDate(acc, asOf);
    for (const { currency, amount } of balances) {
      // Asset-kind account with a negative native balance is a data-quality
      // smell (incomplete CSV history or missing opening balance). Surface
      // the row with a warning but exclude it from the per-currency totals
      // so the headline doesn't lie.
      const flagNegativeAsset = kind === 'asset' && amount < 0;

      const row: BreakdownRow = {
        source: 'account',
        accountId: acc.id,
        label: acc.name,
        currency,
        native: amount,
        cadValue: null,
        openingBalanceSet,
      };
      if (flagNegativeAsset) {
        row.dataQualityWarning = 'asset_balance_negative';
      } else {
        perCurrency[currency] ??= { asset: 0, liability: 0 };
        perCurrency[currency][kind] += toUnits(amount);
      }
      (kind === 'asset' ? assets : liabilities).push(row);
    }
  }

  // Portfolio market-value contributions (the canonical source for
  // investment accounts). Only portfolio-driven accounts participate:
  // non-investment accounts already contributed their full txn-stream
  // balance above, so counting any stray HoldingSnapshot rows on them
  // (statement imported into a mistyped account) would double count.
  // Matches the Portfolio page, which loads holdings only for
  // accountType 'investment' (routes/portfolio.ts).
  const portfolioAccountIds = accounts
    .filter((a) => PORTFOLIO_DRIVEN_TYPES.has(a.accountType))
    .map((a) => a.id);
  const portfolio = await portfolioMarketValueAt(asOf, portfolioAccountIds);
  const portfolioByAcc = new Map<
    string,
    { accountId: number; currency: string; total: number }
  >();
  for (const row of portfolio.rows) {
    perCurrency[row.currency] ??= { asset: 0, liability: 0 };
    perCurrency[row.currency].asset += toUnits(row.marketValue);
    const key = `${row.accountId}:${row.currency}`;
    const entry = portfolioByAcc.get(key) ?? {
      accountId: row.accountId,
      currency: row.currency,
      total: 0,
    };
    entry.total += toUnits(row.marketValue);
    portfolioByAcc.set(key, entry);
  }
  for (const { accountId, currency, total } of portfolioByAcc.values()) {
    const acc = accounts.find((a) => a.id === accountId);
    assets.push({
      source: 'portfolio',
      accountId,
      label: `Portfolio (${acc?.name ?? accountId})`,
      currency,
      native: fromUnits(total),
      cadValue: null,
      // Portfolio rows come from holdings × price; no opening balance concept.
      openingBalanceSet: true,
    });
  }
  gaps.push(...portfolio.gaps);

  const perCurrencyDollars: PerCurrencyByKind = {};
  for (const [currency, { asset, liability }] of Object.entries(perCurrency)) {
    perCurrencyDollars[currency] = { asset: fromUnits(asset), liability: fromUnits(liability) };
  }
  const unified = await unifyToCad(perCurrencyDollars, asOf, fxLookup);
  gaps.push(...unified.gaps);

  return {
    asOf,
    baseCurrency: 'CAD',
    total: unified.totalAssets + unified.totalLiabilities,
    assetsTotal: unified.totalAssets,
    liabilitiesTotal: unified.totalLiabilities,
    breakdown: { assets, liabilities },
    fxRatesUsed: unified.fxRatesUsed,
    partial: gaps.length > 0,
    gaps,
  };
}

export type SeriesPoint = {
  date: string;
  total: number;
  assetsTotal: number;
  liabilitiesTotal: number;
};

export type NetWorthSeries = {
  baseCurrency: 'CAD';
  granularity: 'monthly' | 'daily';
  points: SeriesPoint[];
  partial: boolean;
  gaps: NetWorthGap[];
};

export function monthEndDatesInRange(from: string, to: string): string[] {
  const out: string[] = [];
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
  while (cursor <= end) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 2, 0));
  }
  return out;
}

export function daysInRange(from: string, to: string): string[] {
  const out: string[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor <= end) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

export async function buildSeries(
  from: string,
  to: string,
  granularity: 'monthly' | 'daily',
  accountIds: number[],
  fxLookup: FxLookup = looseHistoricalFxLookup
): Promise<NetWorthSeries> {
  const buckets =
    granularity === 'monthly'
      ? monthEndDatesInRange(from, to)
      : daysInRange(from, to);
  const points: SeriesPoint[] = [];
  const gaps: NetWorthGap[] = [];
  for (const date of buckets) {
    const snap = await buildNetWorthAt(date, accountIds, fxLookup);
    points.push({
      date,
      total: snap.total,
      assetsTotal: snap.assetsTotal,
      liabilitiesTotal: snap.liabilitiesTotal,
    });
    gaps.push(...snap.gaps);
  }
  return {
    baseCurrency: 'CAD',
    granularity,
    points,
    partial: gaps.length > 0,
    gaps,
  };
}
