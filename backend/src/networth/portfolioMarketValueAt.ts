import { Op } from 'sequelize';
import { latestActivePositions } from '../portfolio/latestHoldings';
import { resolveHoldingMarketValue } from '../portfolio/valuation';

export type PortfolioRow = {
  accountId: number;
  securityId: number;
  marketValue: number;
  currency: string;
};

export type PortfolioGap = {
  date: string;
  currency: string;
  reason: 'price_unavailable';
  securityId: number;
};

export type PortfolioMarketValueResult = {
  rows: PortfolioRow[];
  gaps: PortfolioGap[];
};

function n(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * For each (accountId, securityId) pair within the given account scope, compute
 * market value at `asOf`. Value resolution order, matching the existing
 * `portfolio.ts` logic so net worth agrees with the Portfolio page:
 *
 *   1. quantity × latest SecurityPrice ≤ asOf, if a price row exists
 *   2. HoldingSnapshot.marketValue (the import-time value from the bank CSV)
 *      when no price row is available — common for crypto and illiquid
 *      securities that don't have quotes in our SecurityPrice cache
 *   3. otherwise emit a `price_unavailable` gap and exclude
 *
 * Currency falls back from `latestPrice.currency` to `holding.currency` so
 * holdings without quotes still show a sensible currency.
 *
 * Pairs with no qualifying holding (statementDate ≤ asOf) are treated as zero
 * positions (no row, no gap). Likewise, a pair whose latest snapshot predates
 * the account's newest statement ≤ asOf was absent from that statement
 * (fully sold) and is treated as zero from that date onward.
 *
 * SecurityPrice.pricedAt is a DATETIME, so we compare against
 * `${asOf}T23:59:59.999Z` to include same-day prices. HoldingSnapshot.statementDate
 * is a DATEONLY string and is compared directly.
 */
export async function portfolioMarketValueAt(
  asOf: string,
  accountIds: number[]
): Promise<PortfolioMarketValueResult> {
  if (accountIds.length === 0) return { rows: [], gaps: [] };

  const { Account, HoldingSnapshot, SecurityPrice } = await import('../models');

  // Drop accounts closed on/before asOf — their holdings stop contributing
  // to market value at that point. Pre-closure history is preserved because
  // snapshots aren't touched; we just skip them from this aggregation.
  const activeAccounts = await Account.findAll({
    where: {
      id: accountIds,
      [Op.or]: [{ closedAt: null }, { closedAt: { [Op.gt]: asOf } }],
    },
    attributes: ['id'],
  });
  const activeIds = activeAccounts.map((a) => a.id);
  if (activeIds.length === 0) return { rows: [], gaps: [] };

  const allHoldings = await HoldingSnapshot.findAll({
    where: {
      accountId: activeIds,
      statementDate: { [Op.lte]: asOf },
    },
    // id DESC tiebreaker so same-day duplicate snapshots (corrected
    // re-imports) resolve deterministically to the newest row, matching
    // routes/portfolio.ts.
    order: [
      ['statementDate', 'DESC'],
      ['id', 'DESC'],
    ],
  });

  // Current position per (account, security) pair within the asOf-capped
  // scope. A position whose own latest snapshot predates the account's
  // newest statement ≤ asOf was absent from that statement — i.e. fully
  // sold — so it contributes zero from that date onward instead of carrying
  // its last pre-sale value forward forever. The inference lives in
  // portfolio/latestHoldings.ts, shared with routes/portfolio.ts so the
  // Portfolio page and net worth always agree.
  const latest = latestActivePositions(allHoldings);
  if (latest.length === 0) return { rows: [], gaps: [] };

  const securityIds = Array.from(new Set(latest.map((h) => h.securityId)));
  const asOfEndOfDay = `${asOf}T23:59:59.999Z`;
  const allPrices = await SecurityPrice.findAll({
    where: {
      securityId: securityIds,
      pricedAt: { [Op.lte]: asOfEndOfDay },
    },
    order: [['pricedAt', 'DESC']],
  });
  const priceBySecurity = new Map<number, (typeof allPrices)[number]>();
  for (const p of allPrices) {
    if (!priceBySecurity.has(p.securityId)) priceBySecurity.set(p.securityId, p);
  }

  const rows: PortfolioRow[] = [];
  const gaps: PortfolioGap[] = [];

  for (const h of latest) {
    const price = priceBySecurity.get(h.securityId);
    const quantity = n(h.quantity) ?? 0;
    const quotePrice = n(price?.price);
    const importedValue = n(h.marketValue);
    const currency = price?.currency || h.currency;

    // Quote-vs-broker sanity guard (issue #549): a live quote that diverges
    // implausibly from the broker per-unit price is a symbol→ticker collision
    // and must not override the broker-imported value. When neither a usable
    // quote nor an imported value exists, emit a price_unavailable gap.
    let marketValue: number | null = null;
    if (quotePrice != null || importedValue != null) {
      const resolved = resolveHoldingMarketValue({
        quantity,
        importedValue,
        importedPrice: n(h.price),
        quotePrice,
      });
      marketValue = resolved.marketValue;
    }

    if (marketValue == null) {
      gaps.push({
        date: asOf,
        currency,
        reason: 'price_unavailable',
        securityId: h.securityId,
      });
      continue;
    }

    rows.push({
      accountId: h.accountId,
      securityId: h.securityId,
      marketValue,
      currency,
    });
  }

  return { rows, gaps };
}
