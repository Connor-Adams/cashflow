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

/**
 * For each (accountId, securityId) pair within the given account scope, compute
 * market value at `asOf` using:
 *   - latest HoldingSnapshot with statementDate <= asOf
 *   - latest SecurityPrice with pricedAt <= asOf (end-of-day)
 *
 * If a held security has no qualifying price, a `price_unavailable` gap is
 * emitted and the row is excluded. Pairs with no qualifying holding are treated
 * as zero positions (no row, no gap).
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
    if (!price) {
      gaps.push({
        date: asOf,
        currency: h.currency,
        reason: 'price_unavailable',
        securityId: h.securityId,
      });
      continue;
    }
    rows.push({
      accountId: h.accountId,
      securityId: h.securityId,
      marketValue: Number(h.quantity) * Number(price.price),
      currency: price.currency,
    });
  }

  return { rows, gaps };
}
