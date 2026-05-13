import { Router } from 'express';
import { Op } from 'sequelize';
import {
  Account,
  HoldingSnapshot,
  InvestmentActivity,
  Security,
  SecurityPrice,
} from '../models';
import { currentAuth } from '../auth/middleware';
import { visibleAccountWhere } from '../auth/scope';
import * as env from '../config/env';

const router = Router();
const PRICE_CACHE_MS = 60 * 60 * 1000;

function n(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

async function latestPricesBySecurity(securityIds: number[]) {
  if (securityIds.length === 0) return new Map<number, SecurityPrice>();
  const rows = await SecurityPrice.findAll({
    where: { securityId: securityIds },
    order: [['pricedAt', 'DESC']],
  });
  const out = new Map<number, SecurityPrice>();
  for (const row of rows) {
    if (!out.has(row.securityId)) out.set(row.securityId, row);
  }
  return out;
}

router.get('/', async (req, res, next) => {
  try {
    const accounts = await Account.findAll({
      where: { ...visibleAccountWhere(req), accountType: 'investment' },
      order: [['name', 'ASC']],
    });
    const accountIds = accounts.map((row) => row.id);
    const snapshots = accountIds.length
      ? await HoldingSnapshot.findAll({
          where: { accountId: accountIds },
          include: [{ model: Security, as: 'security' }],
          order: [
            ['statementDate', 'DESC'],
            ['id', 'DESC'],
          ],
        })
      : [];
    const latestHoldings = new Map<string, HoldingSnapshot>();
    for (const row of snapshots) {
      const key = `${row.accountId}:${row.securityId}`;
      if (!latestHoldings.has(key)) latestHoldings.set(key, row);
    }
    const holdings = [...latestHoldings.values()];
    const prices = await latestPricesBySecurity([...new Set(holdings.map((h) => h.securityId))]);
    const totals = new Map<string, number>();
    const holdingDtos = holdings.map((holding) => {
      const security = holding.get('security') as Security | undefined;
      const latestPrice = prices.get(holding.securityId);
      const quantity = n(holding.quantity) ?? 0;
      const importedValue = n(holding.marketValue);
      const quotePrice = n(latestPrice?.price);
      const marketValue =
        quotePrice != null ? quantity * quotePrice : importedValue ?? 0;
      const cur = latestPrice?.currency || holding.currency;
      totals.set(cur, (totals.get(cur) ?? 0) + marketValue);
      return {
        id: holding.id,
        accountId: holding.accountId,
        securityId: holding.securityId,
        statementDate: holding.statementDate,
        quantity,
        price: n(holding.price),
        marketValue,
        importedMarketValue: importedValue,
        costBasis: n(holding.costBasis),
        unrealizedGainLoss: n(holding.unrealizedGainLoss),
        currency: cur,
        sourceReference: holding.sourceReference,
        importBatch: holding.importBatch,
        security: security
          ? {
              id: security.id,
              symbol: security.symbol,
              name: security.name,
              assetType: security.assetType,
              currency: security.currency,
            }
          : null,
        latestPrice: latestPrice
          ? {
              id: latestPrice.id,
              provider: latestPrice.provider,
              symbol: latestPrice.symbol,
              pricedAt: latestPrice.pricedAt.toISOString(),
              price: n(latestPrice.price),
              currency: latestPrice.currency,
              fetchedAt: latestPrice.fetchedAt.toISOString(),
            }
          : null,
      };
    });

    const recentActivities = accountIds.length
      ? await InvestmentActivity.findAll({
          where: { accountId: accountIds },
          include: [{ model: Security, as: 'security' }],
          order: [
            ['tradeDate', 'DESC'],
            ['id', 'DESC'],
          ],
          limit: 30,
        })
      : [];

    res.json({
      accounts,
      holdings: holdingDtos,
      totalsByCurrency: [...totals.entries()].map(([currency, marketValue]) => ({
        currency,
        marketValue,
      })),
      recentActivities: recentActivities.map((activity) => {
        const security = activity.get('security') as Security | undefined;
        return {
          id: activity.id,
          accountId: activity.accountId,
          securityId: activity.securityId,
          activityType: activity.activityType,
          tradeDate: activity.tradeDate,
          settlementDate: activity.settlementDate,
          description: activity.description,
          quantity: n(activity.quantity),
          price: n(activity.price),
          amount: n(activity.amount),
          fees: n(activity.fees),
          currency: activity.currency,
          sourceReference: activity.sourceReference,
          importBatch: activity.importBatch,
          security: security
            ? {
                id: security.id,
                symbol: security.symbol,
                name: security.name,
                assetType: security.assetType,
                currency: security.currency,
              }
            : null,
        };
      }),
      quoteProvider: env.quoteProvider,
      quoteConfigured: Boolean(env.alphaVantageApiKey),
    });
  } catch (e) {
    next(e);
  }
});

async function fetchAlphaVantageQuote(symbol: string): Promise<{
  price: number;
  pricedAt: Date;
} | null> {
  if (!env.alphaVantageApiKey) return null;
  const url = new URL('https://www.alphavantage.co/query');
  url.searchParams.set('function', 'GLOBAL_QUOTE');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('apikey', env.alphaVantageApiKey);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Alpha Vantage returned HTTP ${response.status}`);
  }
  const json = (await response.json()) as Record<string, unknown>;
  const quote = json['Global Quote'] as Record<string, string> | undefined;
  const price = n(quote?.['05. price']);
  if (price == null) return null;
  const latestDay = quote?.['07. latest trading day'];
  return {
    price,
    pricedAt: latestDay ? new Date(`${latestDay}T21:00:00.000Z`) : new Date(),
  };
}

router.post('/prices/refresh', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    if (env.quoteProvider !== 'alpha_vantage') {
      res.status(400).json({ error: `Unsupported quote provider: ${env.quoteProvider}` });
      return;
    }
    if (!env.alphaVantageApiKey) {
      res.status(400).json({ error: 'ALPHA_VANTAGE_API_KEY is not configured' });
      return;
    }
    const securities = await Security.findAll({
      where: {
        householdId: household.id,
        symbol: { [Op.ne]: '' },
      },
      order: [['symbol', 'ASC']],
    });
    const latest = await latestPricesBySecurity(securities.map((s) => s.id));
    const results = [];
    for (const security of securities) {
      const cached = latest.get(security.id);
      if (
        cached &&
        Date.now() - cached.fetchedAt.getTime() < PRICE_CACHE_MS
      ) {
        results.push({
          symbol: security.symbol,
          status: 'cached',
          price: n(cached.price),
          fetchedAt: cached.fetchedAt.toISOString(),
        });
        continue;
      }
      try {
        const quote = await fetchAlphaVantageQuote(security.symbol);
        if (!quote) {
          results.push({ symbol: security.symbol, status: 'not_found' });
          continue;
        }
        const row = await SecurityPrice.create({
          securityId: security.id,
          provider: 'alpha_vantage',
          symbol: security.symbol,
          pricedAt: quote.pricedAt,
          price: String(quote.price),
          currency: security.currency,
          fetchedAt: new Date(),
        });
        results.push({
          symbol: security.symbol,
          status: 'refreshed',
          price: quote.price,
          fetchedAt: row.fetchedAt.toISOString(),
        });
      } catch (e) {
        results.push({
          symbol: security.symbol,
          status: 'error',
          error: e instanceof Error ? e.message : 'Quote refresh failed',
        });
      }
    }
    res.json({ provider: 'alpha_vantage', results });
  } catch (e) {
    next(e);
  }
});

export default router;
