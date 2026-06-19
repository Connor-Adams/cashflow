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
import { latestActivePositions } from '../portfolio/latestHoldings';
import { resolveHoldingMarketValue } from '../portfolio/valuation';

/** Parse a possibly-string DECIMAL into a finite number, or null. Mirrors the
 *  `n()` helper in portfolioMarketValueAt.ts so valuation parity holds. */
function pnum(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

// Investment accounts derive their net-worth contribution from holdings
// market value, NOT from the cash-flow transaction stream — txns on these
// accounts (buys, transfers, dividends) net out to portfolio value, and
// summing them as a balance double-counts or produces nonsense.
//
// Exported so other holdings-vs-balance call sites (routes/reporting.ts)
// apply the exact same split: only these account types feed
// portfolioMarketValueAt; everything else contributes its txn-stream
// balance only. Holdings on a mistyped non-investment account would
// otherwise count on top of that account's full balance.
export const PORTFOLIO_DRIVEN_TYPES = new Set(['investment']);

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

/**
 * Wrap an FxLookup in a request-scoped memo keyed by (from,to,asOf). A net
 * worth series re-asks the same currency pairs across every bucket — and the
 * looseHistoricalFxLookup fallback can fire up to three DB queries per miss —
 * so deduping within one request collapses thousands of repeat lookups to one
 * per distinct (pair, date). Null results are cached too, so an absent rate
 * short-circuits the 3-query fallback on subsequent buckets. (Fix #2 of #661.)
 */
export function memoizeFxLookup(fxLookup: FxLookup): FxLookup {
  const cache = new Map<string, Awaited<ReturnType<FxLookup>>>();
  const pending = new Map<string, Promise<Awaited<ReturnType<FxLookup>>>>();
  return async (from, to, asOf) => {
    const key = `${from}|${to}|${asOf}`;
    if (cache.has(key)) return cache.get(key)!;
    const inflight = pending.get(key);
    if (inflight) return inflight;
    const p = fxLookup(from, to, asOf).then((res) => {
      cache.set(key, res);
      pending.delete(key);
      return res;
    });
    pending.set(key, p);
    return p;
  };
}

type CumByCurrency = Map<string, number>; // currency -> integer units (toUnits)

/**
 * Per-account txn-stream state, prefetched once for the whole series. We sweep
 * buckets in ascending date order, advancing a cumulative `cumUpTo` over the
 * sorted txns. The balance at any asOf reduces to
 *   cumUpTo(asOf) − cumUpTo(anchor)   (+ opening on defaultCurrency)
 * which collapses all three branches of `balanceAtDate` (forward, backward,
 * and no-anchor) into one expression — see the proof in the issue/kindex.
 */
// buildSeries emits only date/total/assetsTotal/liabilitiesTotal per point —
// not the breakdown rows — so the `hasTxns`/`openingBalanceSet` flag that
// buildNetWorthAt computes is irrelevant here and we don't track txn counts.
// The negative-asset *exclusion* DOES affect totals and is handled per bucket.
type AccountTxnState = {
  txns: { date: string; currency: string; units: number }[];
  cursor: number; // index into txns of the next txn not yet folded into cum
  cum: CumByCurrency; // running cumUpTo(currentBucket), in integer units
  anchorCum: CumByCurrency; // constant cumUpTo(openingBalanceDate), units
};

function advanceCursor(state: AccountTxnState, asOf: string): void {
  while (state.cursor < state.txns.length && state.txns[state.cursor].date <= asOf) {
    const t = state.txns[state.cursor];
    state.cum.set(t.currency, (state.cum.get(t.currency) ?? 0) + t.units);
    state.cursor += 1;
  }
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

  if (buckets.length === 0) {
    return { baseCurrency: 'CAD', granularity, points: [], partial: false, gaps: [] };
  }

  // Empty account scope: one zero point per bucket (matches the per-bucket
  // buildNetWorthAt, which returns a zero snapshot — not an empty series).
  if (accountIds.length === 0) {
    return {
      baseCurrency: 'CAD',
      granularity,
      points: buckets.map((date) => ({ date, total: 0, assetsTotal: 0, liabilitiesTotal: 0 })),
      partial: false,
      gaps: [],
    };
  }

  const memoFx = memoizeFxLookup(fxLookup);
  const maxBucket = buckets[buckets.length - 1];

  const { Account, Transaction, HoldingSnapshot, SecurityPrice } = await import('../models');

  // ---- Prefetch (1): accounts once -------------------------------------
  const allAccounts = await Account.findAll({ where: { id: accountIds } });
  const cashAccounts = allAccounts.filter(
    (a) => !PORTFOLIO_DRIVEN_TYPES.has(a.accountType)
  );
  const portfolioAccounts = allAccounts.filter((a) =>
    PORTFOLIO_DRIVEN_TYPES.has(a.accountType)
  );
  const portfolioAccountIds = portfolioAccounts.map((a) => a.id);

  // ---- Prefetch (2): all in-scope cash txns once -----------------------
  // We need txns up to the LATEST bucket, plus (for accounts whose anchor is
  // beyond the last bucket) txns up to the anchor — both are bounded by the
  // overall max(maxBucket, max(openingBalanceDate)). Fetch the whole stream
  // ≤ that bound, sorted ascending, then sweep per account.
  const maxAnchor = cashAccounts.reduce<string>(
    (m, a) => (a.openingBalanceDate && a.openingBalanceDate > m ? a.openingBalanceDate : m),
    maxBucket
  );
  const cashAccountIds = cashAccounts.map((a) => a.id);
  const txnRows = cashAccountIds.length
    ? await Transaction.findAll({
        where: { accountId: cashAccountIds, date: { [Op.lte]: maxAnchor } },
        attributes: ['accountId', 'date', 'currency', 'amount'],
        order: [['date', 'ASC'], ['id', 'ASC']],
      })
    : [];

  const txnState = new Map<number, AccountTxnState>();
  for (const acc of cashAccounts) {
    txnState.set(acc.id, {
      txns: [],
      cursor: 0,
      cum: new Map(),
      anchorCum: new Map(),
    });
  }
  for (const t of txnRows) {
    const st = txnState.get(t.accountId);
    if (!st) continue;
    st.txns.push({ date: t.date, currency: t.currency, units: toUnits(Number(t.amount)) });
  }
  // Precompute each account's constant cumUpTo(anchor) once.
  for (const acc of cashAccounts) {
    const st = txnState.get(acc.id)!;
    if (!acc.openingBalanceDate) continue;
    for (const t of st.txns) {
      if (t.date <= acc.openingBalanceDate) {
        st.anchorCum.set(t.currency, (st.anchorCum.get(t.currency) ?? 0) + t.units);
      }
    }
  }

  // ---- Prefetch (3): all portfolio holdings + prices once --------------
  // Snapshots ≤ maxBucket and prices ≤ end-of-maxBucket cover every earlier
  // bucket too; closedAt is handled per-bucket below. We re-derive
  // latest-position + price-as-of in memory per bucket.
  const holdingsAll = portfolioAccountIds.length
    ? await HoldingSnapshot.findAll({
        where: { accountId: portfolioAccountIds, statementDate: { [Op.lte]: maxBucket } },
        order: [['statementDate', 'DESC'], ['id', 'DESC']],
      })
    : [];
  const securityIds = Array.from(new Set(holdingsAll.map((h) => h.securityId)));
  const pricesAll = securityIds.length
    ? await SecurityPrice.findAll({
        where: {
          securityId: securityIds,
          pricedAt: { [Op.lte]: `${maxBucket}T23:59:59.999Z` },
        },
        order: [['pricedAt', 'DESC']],
      })
    : [];

  // ---- Sweep buckets, computing each point from prefetched data --------
  const points: SeriesPoint[] = [];
  const gaps: NetWorthGap[] = [];

  for (const asOf of buckets) {
    const perCurrency: PerCurrencyByKind = {};

    // Cash accounts
    for (const acc of cashAccounts) {
      // Closed accounts contribute zero from closed_at onward.
      if (acc.closedAt && acc.closedAt <= asOf) continue;
      const st = txnState.get(acc.id)!;
      advanceCursor(st, asOf);
      const kind = accountKind(acc.accountType);
      const defCcy = acc.defaultCurrency ?? 'CAD';
      const opening = Number(acc.openingBalance) || 0;

      // balance(asOf) per currency = cumUpTo(asOf) − cumUpTo(anchor); opening
      // is folded onto the default currency. Build the per-currency set as the
      // union of currencies seen up to asOf and the anchor window.
      const currencies = new Set<string>([defCcy, ...st.cum.keys(), ...st.anchorCum.keys()]);
      for (const currency of currencies) {
        let units = (st.cum.get(currency) ?? 0) - (st.anchorCum.get(currency) ?? 0);
        if (currency === defCcy) units += toUnits(opening);
        const amount = fromUnits(units);
        const flagNegativeAsset = kind === 'asset' && amount < 0;
        if (flagNegativeAsset) continue; // excluded from totals (still surfaced in /current)
        perCurrency[currency] ??= { asset: 0, liability: 0 };
        perCurrency[currency][kind] += units;
      }
    }

    // Portfolio accounts
    const activePortfolioIds = new Set(
      portfolioAccounts.filter((a) => !a.closedAt || a.closedAt > asOf).map((a) => a.id)
    );
    if (activePortfolioIds.size > 0) {
      const holdingsInScope = holdingsAll.filter(
        (h) => activePortfolioIds.has(h.accountId) && h.statementDate <= asOf
      );
      const latest = latestActivePositions(holdingsInScope);
      const asOfEod = `${asOf}T23:59:59.999Z`;
      for (const h of latest) {
        // newest price ≤ asOf for this security
        let price: (typeof pricesAll)[number] | undefined;
        for (const p of pricesAll) {
          if (p.securityId === h.securityId && p.pricedAt.toISOString() <= asOfEod) {
            price = p; // pricesAll is sorted pricedAt DESC, first match wins
            break;
          }
        }
        const quantity = pnum(h.quantity) ?? 0;
        const quotePrice = pnum(price?.price);
        const importedValue = pnum(h.marketValue);
        const currency = price?.currency || h.currency;
        let marketValue: number | null = null;
        if (quotePrice != null || importedValue != null) {
          marketValue = resolveHoldingMarketValue({
            quantity,
            importedValue,
            importedPrice: pnum(h.price),
            quotePrice,
          }).marketValue;
        }
        if (marketValue == null) {
          gaps.push({ date: asOf, currency, reason: 'price_unavailable', securityId: h.securityId });
          continue;
        }
        perCurrency[currency] ??= { asset: 0, liability: 0 };
        perCurrency[currency].asset += toUnits(marketValue);
      }
    }

    // Unify to CAD via the memoized FX lookup.
    const perCurrencyDollars: PerCurrencyByKind = {};
    for (const [currency, { asset, liability }] of Object.entries(perCurrency)) {
      perCurrencyDollars[currency] = { asset: fromUnits(asset), liability: fromUnits(liability) };
    }
    const unified = await unifyToCad(perCurrencyDollars, asOf, memoFx);
    gaps.push(...unified.gaps);

    points.push({
      date: asOf,
      total: unified.totalAssets + unified.totalLiabilities,
      assetsTotal: unified.totalAssets,
      liabilitiesTotal: unified.totalLiabilities,
    });
  }

  return {
    baseCurrency: 'CAD',
    granularity,
    points,
    partial: gaps.length > 0,
    gaps,
  };
}
