/**
 * Convert a foreign-currency income inflow on an investment activity into the
 * account's currency at the trade-date FX rate.
 *
 * Why: the Wealthsimple activities-export CSV reports crypto staking rewards in
 * the token's quote currency (USD) even for a CAD account, and the parser
 * persists those USD values verbatim (price/amount + currency='USD'). That left
 * a CAD account with USD-denominated reward rows, inconsistent with its CAD
 * buys and silently mis-scaled for any consumer that doesn't FX-convert.
 *
 * Scope is deliberately narrow: only activity types that represent a cash
 * INFLOW whose foreign-currency face value should be expressed in the account
 * currency. A buy/sell of a natively USD-priced security (e.g. VTI in a CAD
 * account) must KEEP currency='USD' — its price is a real USD market price and
 * downstream metrics normalize it per-security. So we convert income inflows
 * only, never trades.
 */

export type ActivityRateFetcher = (
  from: string,
  to: string,
  date: string,
) => Promise<{ rate: number } | null>;

export interface CurrencyConvertibleActivity {
  activityType: string;
  currency: string | null;
  amount: number | null;
  price: number | null;
  fees: number | null;
  tradeDate: string;
}

export interface ConvertedActivityCurrency {
  amount: number | null;
  price: number | null;
  fees: number | null;
  currency: string | null;
  converted: boolean;
}

// Income-inflow activity types whose foreign-currency value is re-expressed in
// the account currency. Trades (buy/sell/transfer) are intentionally excluded.
const FOREIGN_INCOME_TYPES = new Set(['staking_reward']);

const round = (n: number, dp: number): number => {
  const f = 10 ** dp;
  return Math.round((n + Number.EPSILON) * f) / f;
};

export async function convertIncomeActivityToAccountCurrency(
  activity: CurrencyConvertibleActivity,
  accountCurrency: string,
  fetchRate: ActivityRateFetcher,
): Promise<ConvertedActivityCurrency> {
  const { activityType, currency, amount, price, fees } = activity;
  const unchanged: ConvertedActivityCurrency = { amount, price, fees, currency, converted: false };

  if (!FOREIGN_INCOME_TYPES.has(activityType) || !currency || currency === accountCurrency) {
    return unchanged;
  }

  const fx = await fetchRate(currency, accountCurrency, activity.tradeDate);
  if (!fx) return unchanged; // safe degrade: leave native currency rather than crash the import

  const r = fx.rate;
  return {
    amount: amount == null ? null : round(amount * r, 4),
    price: price == null ? null : round(price * r, 8),
    fees: fees == null ? null : round(fees * r, 4),
    currency: accountCurrency,
    converted: true,
  };
}
