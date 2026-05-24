import { accountKind } from './accountKind';
import { balanceAtDate } from './balanceAtDate';
import { portfolioMarketValueAt } from './portfolioMarketValueAt';
import { unifyToCad, type PerCurrencyByKind, type FxRateUsed, type FxLookup } from './unifyToCad';

export type BreakdownRow = {
  source: 'account' | 'portfolio';
  accountId: number | null;
  label: string;
  currency: string;
  native: number | null;
  cadValue: number | null;
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

export async function buildNetWorthAt(
  asOf: string,
  accountIds: number[],
  fxLookup?: FxLookup
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

  const { Account } = await import('../models');
  const accounts = await Account.findAll({ where: { id: accountIds } });

  for (const acc of accounts) {
    const kind = accountKind(acc.accountType);
    const balances = await balanceAtDate(acc, asOf);
    for (const { currency, amount } of balances) {
      perCurrency[currency] ??= { asset: 0, liability: 0 };
      perCurrency[currency][kind] += amount;
      (kind === 'asset' ? assets : liabilities).push({
        source: 'account',
        accountId: acc.id,
        label: acc.name,
        currency,
        native: amount,
        cadValue: null,
      });
    }
  }

  const portfolio = await portfolioMarketValueAt(asOf, accountIds);
  // Group portfolio rows by (accountId, currency) for breakdown
  const portfolioByAcc = new Map<string, { accountId: number; currency: string; total: number }>();
  for (const row of portfolio.rows) {
    perCurrency[row.currency] ??= { asset: 0, liability: 0 };
    perCurrency[row.currency].asset += row.marketValue;
    const key = `${row.accountId}:${row.currency}`;
    const entry = portfolioByAcc.get(key) ?? { accountId: row.accountId, currency: row.currency, total: 0 };
    entry.total += row.marketValue;
    portfolioByAcc.set(key, entry);
  }
  for (const { accountId, currency, total } of portfolioByAcc.values()) {
    const acc = accounts.find((a) => a.id === accountId);
    assets.push({
      source: 'portfolio',
      accountId,
      label: `Portfolio (${acc?.name ?? accountId})`,
      currency,
      native: total,
      cadValue: null,
    });
  }
  gaps.push(...portfolio.gaps);

  const unified = await unifyToCad(perCurrency, asOf, fxLookup);
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
