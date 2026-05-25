import { Op } from 'sequelize';

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
 * positions (no row, no gap).
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

  const { HoldingSnapshot, SecurityPrice } = await import('../models');

  const allHoldings = await HoldingSnapshot.findAll({
    where: {
      accountId: accountIds,
      statementDate: { [Op.lte]: asOf },
    },
    order: [['statementDate', 'DESC']],
  });

  const latest = new Map<string, (typeof allHoldings)[number]>();
  for (const h of allHoldings) {
    const key = `${h.accountId}:${h.securityId}`;
    if (!latest.has(key)) latest.set(key, h);
  }
  if (latest.size === 0) return { rows: [], gaps: [] };

  const securityIds = Array.from(
    new Set(Array.from(latest.values(), (h) => h.securityId))
  );
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

  for (const h of latest.values()) {
    const price = priceBySecurity.get(h.securityId);
    const quantity = n(h.quantity) ?? 0;
    const quotePrice = n(price?.price);
    const importedValue = n(h.marketValue);
    const currency = price?.currency || h.currency;

    let marketValue: number | null = null;
    if (quotePrice != null) {
      marketValue = quantity * quotePrice;
    } else if (importedValue != null) {
      marketValue = importedValue;
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
