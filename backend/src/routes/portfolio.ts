import { Router, type Request } from 'express';
import { Op } from 'sequelize';
import {
  Account,
  HoldingSnapshot,
  InvestmentActivity,
  Security,
  SecurityPrice,
  SecurityDailyPrice,
  SecurityDividend,
} from '../models';
import { ensureDailyPrices, ensureDividends, ensureOverview } from '../portfolio/backfill';
import {
  loadMetricsContext,
  computeRowMetrics,
  computeWeightPct,
  computeTotalReturnPct,
  computeUnifiedTodayDelta,
} from '../portfolio/metrics';
import { currentAuth } from '../auth/middleware';
import { visibleAccountWhere } from '../auth/scope';
import { computeAcb, type AcbActivity, type AcbResult } from '../portfolio/acb';
import { normalizeActivitiesToCad } from '../portfolio/normalizeActivitiesCurrency';
import { ensureFxRate } from '../fx/bankOfCanada';
import {
  YAHOO_PROVIDER,
  YahooFinanceError,
  fetchQuote,
} from '../integrations/yahoo/client';
import { recordCall } from '../integrations/yahoo/jobLog';
import { enumerateYahooSymbols } from '../integrations/yahoo/symbol';
import {
  TAX_STATUS_LABELS,
  TAX_STATUS_ORDER,
  rowFlags,
  harvestCandidate,
  type RowFlag,
} from '../portfolio/tax-buckets';
import { PortfolioForwardProjection } from '../models/PortfolioForwardProjection';
import { rebuildForwardProjectionsForHousehold } from '../portfolio/forwardIncomeBuilder';
import { PortfolioDailySnapshot } from '../models/PortfolioDailySnapshot';
import { Household } from '../models/Household';
import { FxRate } from '../models/FxRate';
import {
  computeTwr,
  computeXirr,
  buildCashFlowSeries,
  computeBenchmarkSeries,
  type DailyPoint,
  type AggregatedDailySnapshot,
} from '../portfolio/returns';
import type {
  PortfolioForwardIncome,
  PortfolioPerformance,
  PortfolioPerformanceRange,
  PortfolioPerformanceStats,
} from '@cashflow/shared';

const router = Router();
const PRICE_CACHE_MS = 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

/**
 * Convert per-currency market values to a single CAD total using the Bank of
 * Canada daily rate. Returns null if any currency-to-CAD conversion fails so
 * we never show a misleading partial total.
 */
async function buildUnifiedCadTotal(
  perCurrency: Array<{ currency: string; marketValue: number }>,
  asOfDate: string
): Promise<{
  baseCurrency: 'CAD';
  marketValue: number;
  ratesUsed: Array<{ from: string; to: string; rate: number; ratedDate: string }>;
} | null> {
  let total = 0;
  const ratesUsed: Array<{ from: string; to: string; rate: number; ratedDate: string }> = [];

  for (const row of perCurrency) {
    if (row.currency === 'CAD') {
      total += row.marketValue;
      // No need to add a rate entry for identity conversion.
      continue;
    }
    const fxResult = await ensureFxRate(row.currency, 'CAD', asOfDate);
    if (!fxResult) {
      // Hard failure on any currency — abort and return null.
      console.warn(
        `[portfolio] buildUnifiedCadTotal: no FX rate for ${row.currency}→CAD on ${asOfDate}`
      );
      return null;
    }
    total += row.marketValue * fxResult.rate;
    // Deduplicate: only record each currency pair once.
    if (!ratesUsed.some((r) => r.from === row.currency && r.to === 'CAD')) {
      ratesUsed.push({
        from: row.currency,
        to: 'CAD',
        rate: fxResult.rate,
        ratedDate: fxResult.ratedDate,
      });
    }
  }

  return { baseCurrency: 'CAD', marketValue: total, ratesUsed };
}

/**
 * Pull the most-recent HoldingSnapshot row for every (account, security)
 * tuple in the caller's visible scope. Returns the rows AND a parallel
 * map of accountId → Account so callers can attach an account name.
 */
async function loadVisibleLatestHoldings(req: Request): Promise<{
  accounts: Account[];
  latestHoldings: HoldingSnapshot[];
}> {
  const accounts = await Account.findAll({
    where: { ...visibleAccountWhere(req), accountType: 'investment' },
    order: [['name', 'ASC']],
  });
  const accountIds = accounts.map((row) => row.id);
  if (accountIds.length === 0) return { accounts, latestHoldings: [] };
  const snapshots = await HoldingSnapshot.findAll({
    where: { accountId: accountIds },
    include: [{ model: Security, as: 'security' }],
    order: [
      ['statementDate', 'DESC'],
      ['id', 'DESC'],
    ],
  });
  const seen = new Set<string>();
  const latestHoldings: HoldingSnapshot[] = [];
  for (const row of snapshots) {
    const key = `${row.accountId}:${row.securityId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    latestHoldings.push(row);
  }
  return { accounts, latestHoldings };
}

router.get('/', async (req, res, next) => {
  try {
    const { accounts, latestHoldings } = await loadVisibleLatestHoldings(req);
    const accountIds = accounts.map((row) => row.id);
    const prices = await latestPricesBySecurity([
      ...new Set(latestHoldings.map((h) => h.securityId)),
    ]);
    const securityIds = [...new Set(latestHoldings.map((h) => h.securityId))];
    const currencies = [...new Set(latestHoldings.map((h) => {
      const lp = prices.get(h.securityId);
      return (lp?.currency ?? h.currency) as string;
    }))];
    const accountIdsForCtx = accounts.map((a) => a.id);
    const metricsCtx = await loadMetricsContext({
      securityIds,
      currencies,
      accountIds: accountIdsForCtx,
    });

    const totals = new Map<string, number>();
    const holdingDtos = latestHoldings.map((holding) => {
      const security = holding.get('security') as Security | undefined;
      const latestPrice = prices.get(holding.securityId);
      const quantity = n(holding.quantity) ?? 0;
      const importedValue = n(holding.marketValue);
      const quotePrice = n(latestPrice?.price);
      const marketValue =
        quotePrice != null ? quantity * quotePrice : importedValue ?? 0;
      const cur = latestPrice?.currency || holding.currency;
      totals.set(cur, (totals.get(cur) ?? 0) + marketValue);
      const rowMetrics = computeRowMetrics({
        ctx: metricsCtx,
        securityId: holding.securityId,
        qty: quantity,
        costBasis: n(holding.costBasis),
      });
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
        todayChangePct: rowMetrics.todayChangePct,
        thirtyDayReturnPct: rowMetrics.thirtyDayReturnPct,
        yieldOnCostPct: rowMetrics.yieldOnCostPct,
        weightPct: null as number | null, // populated after unifiedTotal known
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

    const totalsByCurrency = [...totals.entries()].map(([currency, marketValue]) => ({
      currency,
      marketValue,
    }));

    const todayDate = new Date().toISOString().slice(0, 10);
    const unifiedTotal = await buildUnifiedCadTotal(totalsByCurrency, todayDate);

    // Per-row weight pct now that unifiedTotal is known.
    if (unifiedTotal) {
      for (const dto of holdingDtos) {
        const fxRate =
          dto.currency === 'CAD' ? 1 : metricsCtx.fxRates.get(dto.currency);
        if (fxRate == null) continue;
        const cadMV = dto.marketValue * fxRate;
        dto.weightPct = computeWeightPct({
          ctx: metricsCtx,
          cadMarketValue: cadMV,
          unifiedTotalCad: unifiedTotal.marketValue,
        });
      }
    }

    const todayDelta = computeUnifiedTodayDelta({
      ctx: metricsCtx,
      holdings: latestHoldings.map((h) => {
        const lp = prices.get(h.securityId);
        return {
          securityId: h.securityId,
          quantity: n(h.quantity) ?? 0,
          currency: lp?.currency ?? h.currency,
        };
      }),
    });
    const unifiedTotalWithDelta = unifiedTotal
      ? { ...unifiedTotal, todayChangePct: todayDelta.todayChangePct, todayChangeCad: todayDelta.todayChangeCad }
      : null;

    res.json({
      accounts,
      holdings: holdingDtos,
      totalsByCurrency,
      unifiedTotal: unifiedTotalWithDelta,
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
      quoteProvider: YAHOO_PROVIDER,
      quoteConfigured: true,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * Compute current market value for one HoldingSnapshot row using the
 * latest quote when available, falling back to the imported broker
 * market value. Returns { marketValue, currency }.
 */
function valueHolding(
  holding: HoldingSnapshot,
  latestPrice?: SecurityPrice
): { marketValue: number; currency: string } {
  const quantity = n(holding.quantity) ?? 0;
  const quotePrice = n(latestPrice?.price);
  const importedValue = n(holding.marketValue);
  const marketValue =
    quotePrice != null ? quantity * quotePrice : importedValue ?? 0;
  const currency = latestPrice?.currency || holding.currency;
  return { marketValue, currency };
}

/**
 * GET /api/portfolio/allocation — current asset allocation by asset
 * type, security, and account. Percentages are computed per currency
 * bucket so we never mix CAD and USD into one denominator.
 */
router.get('/allocation', async (req, res, next) => {
  try {
    const { accounts, latestHoldings } = await loadVisibleLatestHoldings(req);
    const prices = await latestPricesBySecurity([
      ...new Set(latestHoldings.map((h) => h.securityId)),
    ]);
    const accountById = new Map(accounts.map((a) => [a.id, a]));

    type ValuedHolding = {
      holding: HoldingSnapshot;
      security: Security | undefined;
      marketValue: number;
      currency: string;
    };
    const valued: ValuedHolding[] = latestHoldings.map((holding) => {
      const security = holding.get('security') as Security | undefined;
      const latestPrice = prices.get(holding.securityId);
      const { marketValue, currency } = valueHolding(holding, latestPrice);
      return { holding, security, marketValue, currency };
    });

    // Per-currency totals — used as denominator for percentages.
    const totalsByCurrency = new Map<string, number>();
    for (const v of valued) {
      totalsByCurrency.set(
        v.currency,
        (totalsByCurrency.get(v.currency) ?? 0) + v.marketValue
      );
    }
    const pct = (currency: string, value: number): number => {
      const total = totalsByCurrency.get(currency) ?? 0;
      return total > 0 ? (value / total) * 100 : 0;
    };

    // By asset type, partitioned by currency.
    const assetTypeBuckets = new Map<
      string,
      { assetType: string; currency: string; marketValue: number }
    >();
    for (const v of valued) {
      const assetType = v.security?.assetType ?? 'Unknown';
      const key = `${assetType}|${v.currency}`;
      const existing = assetTypeBuckets.get(key);
      if (existing) {
        existing.marketValue += v.marketValue;
      } else {
        assetTypeBuckets.set(key, {
          assetType,
          currency: v.currency,
          marketValue: v.marketValue,
        });
      }
    }
    const byAssetType = [...assetTypeBuckets.values()]
      .map((row) => ({
        ...row,
        percentage: pct(row.currency, row.marketValue),
      }))
      .sort((a, b) => b.marketValue - a.marketValue);

    // By security.
    const securityBuckets = new Map<
      string,
      {
        securityId: number;
        symbol: string;
        name: string | null;
        marketValue: number;
        currency: string;
      }
    >();
    for (const v of valued) {
      if (!v.security) continue;
      const key = `${v.security.id}|${v.currency}`;
      const existing = securityBuckets.get(key);
      if (existing) {
        existing.marketValue += v.marketValue;
      } else {
        securityBuckets.set(key, {
          securityId: v.security.id,
          symbol: v.security.symbol,
          name: v.security.name,
          marketValue: v.marketValue,
          currency: v.currency,
        });
      }
    }
    const bySecurity = [...securityBuckets.values()]
      .map((row) => ({
        ...row,
        percentage: pct(row.currency, row.marketValue),
      }))
      .sort((a, b) => b.marketValue - a.marketValue);

    // By account.
    const accountBuckets = new Map<
      string,
      {
        accountId: number;
        accountName: string;
        marketValue: number;
        currency: string;
      }
    >();
    for (const v of valued) {
      const key = `${v.holding.accountId}|${v.currency}`;
      const existing = accountBuckets.get(key);
      if (existing) {
        existing.marketValue += v.marketValue;
      } else {
        accountBuckets.set(key, {
          accountId: v.holding.accountId,
          accountName:
            accountById.get(v.holding.accountId)?.name ??
            String(v.holding.accountId),
          marketValue: v.marketValue,
          currency: v.currency,
        });
      }
    }
    const byAccount = [...accountBuckets.values()]
      .map((row) => ({
        ...row,
        percentage: pct(row.currency, row.marketValue),
      }))
      .sort((a, b) => b.marketValue - a.marketValue);

    res.json({ byAssetType, bySecurity, byAccount });
  } catch (e) {
    next(e);
  }
});

function parseDateRange(req: Request): { dateFrom: string | null; dateTo: string | null } {
  const dateFrom =
    typeof req.query.dateFrom === 'string' && DATE_RE.test(req.query.dateFrom)
      ? req.query.dateFrom
      : null;
  const dateTo =
    typeof req.query.dateTo === 'string' && DATE_RE.test(req.query.dateTo)
      ? req.query.dateTo
      : null;
  return { dateFrom, dateTo };
}

/**
 * GET /api/portfolio/income — dividend and interest income, grouped by
 * month, security, and account. Optional ?dateFrom=YYYY-MM-DD&dateTo=...
 */
router.get('/income', async (req, res, next) => {
  try {
    const accounts = await Account.findAll({
      where: { ...visibleAccountWhere(req), accountType: 'investment' },
      order: [['name', 'ASC']],
    });
    const accountIds = accounts.map((a) => a.id);
    if (accountIds.length === 0) {
      res.json({ byMonth: [], bySecurity: [], byAccount: [], totals: [] });
      return;
    }
    const { dateFrom, dateTo } = parseDateRange(req);
    const where: Record<string, unknown> = {
      accountId: accountIds,
      activityType: ['dividend', 'interest'],
    };
    if (dateFrom || dateTo) {
      const cond: Record<symbol, string> = {};
      if (dateFrom) cond[Op.gte] = dateFrom;
      if (dateTo) cond[Op.lte] = dateTo;
      where.tradeDate = cond;
    }
    const activities = await InvestmentActivity.findAll({
      where,
      include: [{ model: Security, as: 'security' }],
      order: [['tradeDate', 'ASC']],
    });
    const accountById = new Map(accounts.map((a) => [a.id, a]));

    type IncomeBucket = { dividend: number; interest: number; total: number };
    const blank = (): IncomeBucket => ({ dividend: 0, interest: 0, total: 0 });

    const monthMap = new Map<string, { month: string; currency: string } & IncomeBucket>();
    const securityMap = new Map<
      string,
      {
        securityId: number | null;
        symbol: string | null;
        currency: string;
        activityCount: number;
      } & IncomeBucket
    >();
    const accountMap = new Map<
      string,
      { accountId: number; accountName: string; currency: string } & IncomeBucket
    >();
    const totalsMap = new Map<string, { currency: string } & IncomeBucket>();

    for (const row of activities) {
      const amount = Math.abs(n(row.amount) ?? 0);
      if (amount === 0) continue;
      const security = row.get('security') as Security | undefined;
      const currency = row.currency;
      const month = row.tradeDate.slice(0, 7);
      const isDiv = row.activityType === 'dividend';

      const apply = (b: IncomeBucket) => {
        if (isDiv) b.dividend += amount;
        else b.interest += amount;
        b.total += amount;
      };

      const monthKey = `${month}|${currency}`;
      const monthBucket =
        monthMap.get(monthKey) ?? Object.assign(blank(), { month, currency });
      apply(monthBucket);
      monthMap.set(monthKey, monthBucket);

      const secKey = `${security?.id ?? 'null'}|${currency}`;
      const secBucket =
        securityMap.get(secKey) ??
        Object.assign(blank(), {
          securityId: security?.id ?? null,
          symbol: security?.symbol ?? null,
          currency,
          activityCount: 0,
        });
      apply(secBucket);
      secBucket.activityCount += 1;
      securityMap.set(secKey, secBucket);

      const accKey = `${row.accountId}|${currency}`;
      const accBucket =
        accountMap.get(accKey) ??
        Object.assign(blank(), {
          accountId: row.accountId,
          accountName: accountById.get(row.accountId)?.name ?? String(row.accountId),
          currency,
        });
      apply(accBucket);
      accountMap.set(accKey, accBucket);

      const totalsBucket =
        totalsMap.get(currency) ?? Object.assign(blank(), { currency });
      apply(totalsBucket);
      totalsMap.set(currency, totalsBucket);
    }

    res.json({
      byMonth: [...monthMap.values()].sort((a, b) =>
        a.month === b.month ? a.currency.localeCompare(b.currency) : a.month.localeCompare(b.month)
      ),
      bySecurity: [...securityMap.values()].sort((a, b) => b.total - a.total),
      byAccount: [...accountMap.values()].sort((a, b) => b.total - a.total),
      totals: [...totalsMap.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
    });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/portfolio/by-security — cross-account aggregate per ticker.
 * Sums quantity, cost basis, and market value across every account
 * that currently holds the security.
 */
router.get('/by-security', async (req, res, next) => {
  try {
    const { accounts, latestHoldings } = await loadVisibleLatestHoldings(req);
    const accountById = new Map(accounts.map((a) => [a.id, a]));
    const prices = await latestPricesBySecurity([
      ...new Set(latestHoldings.map((h) => h.securityId)),
    ]);

    type Row = {
      securityId: number;
      symbol: string;
      name: string | null;
      assetType: string | null;
      currency: string;
      totalQuantity: number;
      totalCostBasis: number | null;
      totalMarketValue: number;
      unrealizedGainLoss: number | null;
      accountBreakdown: Array<{
        accountId: number;
        accountName: string;
        quantity: number;
        costBasis: number | null;
        marketValue: number;
      }>;
      latestPrice: {
        price: number;
        pricedAt: string;
        provider: string;
        currency: string;
      } | null;
    };

    const map = new Map<number, Row>();
    for (const holding of latestHoldings) {
      const security = holding.get('security') as Security | undefined;
      if (!security) continue;
      const latestPrice = prices.get(holding.securityId);
      const { marketValue, currency } = valueHolding(holding, latestPrice);
      const qty = n(holding.quantity) ?? 0;
      const cost = n(holding.costBasis);
      const accountName = accountById.get(holding.accountId)?.name ?? String(holding.accountId);

      const existing = map.get(security.id);
      if (existing) {
        existing.totalQuantity += qty;
        existing.totalMarketValue += marketValue;
        // null-propagation: if any account has no cost basis we report null for the total.
        if (cost == null || existing.totalCostBasis == null) {
          existing.totalCostBasis = null;
        } else {
          existing.totalCostBasis += cost;
        }
        existing.accountBreakdown.push({
          accountId: holding.accountId,
          accountName,
          quantity: qty,
          costBasis: cost,
          marketValue,
        });
      } else {
        const priceDto = latestPrice
          ? {
              price: n(latestPrice.price) ?? 0,
              pricedAt: latestPrice.pricedAt.toISOString(),
              provider: latestPrice.provider,
              currency: latestPrice.currency,
            }
          : null;
        map.set(security.id, {
          securityId: security.id,
          symbol: security.symbol,
          name: security.name,
          assetType: security.assetType,
          currency,
          totalQuantity: qty,
          totalCostBasis: cost,
          totalMarketValue: marketValue,
          unrealizedGainLoss: null,
          accountBreakdown: [
            {
              accountId: holding.accountId,
              accountName,
              quantity: qty,
              costBasis: cost,
              marketValue,
            },
          ],
          latestPrice: priceDto,
        });
      }
    }
    const baseRows = [...map.values()].map((row) => ({
      ...row,
      unrealizedGainLoss:
        row.totalCostBasis != null ? row.totalMarketValue - row.totalCostBasis : null,
    }));

    const rows: typeof baseRows = [];
    for (const row of baseRows) {
      rows.push(row);
    }
    rows.sort((a, b) => b.totalMarketValue - a.totalMarketValue);

    // Slice A — metrics enrichment
    const securityIds = rows.map((r) => r.securityId);
    const currencies = [...new Set(rows.map((r) => r.currency))];
    const accountIdsForCtx = accounts.map((a) => a.id);
    const metricsCtx = await loadMetricsContext({
      securityIds,
      currencies,
      accountIds: accountIdsForCtx,
    });

    // Populate realizedBySec by computing ACB per security
    for (const row of rows) {
      const acts = await InvestmentActivity.findAll({
        where: { securityId: row.securityId, accountId: accountIdsForCtx },
        order: [['tradeDate', 'ASC'], ['id', 'ASC']],
      });
      const acbInput: AcbActivity[] = acts.map((a) => ({
        id: a.id,
        activityType: a.activityType,
        tradeDate: a.tradeDate,
        quantity: n(a.quantity),
        price: n(a.price),
        amount: n(a.amount),
        fees: n(a.fees),
        currency: a.currency,
      }));
      const acb = computeAcb(acbInput);
      metricsCtx.realizedBySec.set(row.securityId, acb.realizedTotal);
    }

    // Build totals-by-currency map for unifiedTotal
    const bySecTotals = new Map<string, number>();
    for (const row of rows) {
      bySecTotals.set(row.currency, (bySecTotals.get(row.currency) ?? 0) + row.totalMarketValue);
    }
    const totalsByCurrency = [...bySecTotals.entries()].map(([currency, marketValue]) => ({
      currency,
      marketValue,
    }));
    const todayDate = new Date().toISOString().slice(0, 10);
    const unifiedTotal = await buildUnifiedCadTotal(totalsByCurrency, todayDate);

    // Per-row metrics + weightPct + totalReturnPct
    const rowsWithMetrics = rows.map((row) => {
      const fxRate =
        row.currency === 'CAD' ? 1 : metricsCtx.fxRates.get(row.currency);
      const cadMV = fxRate != null ? row.totalMarketValue * fxRate : null;
      const m = computeRowMetrics({
        ctx: metricsCtx,
        securityId: row.securityId,
        qty: row.totalQuantity,
        costBasis: row.totalCostBasis,
      });
      return {
        ...row,
        todayChangePct: m.todayChangePct,
        thirtyDayReturnPct: m.thirtyDayReturnPct,
        weightPct:
          cadMV != null
            ? computeWeightPct({
                ctx: metricsCtx,
                cadMarketValue: cadMV,
                unifiedTotalCad: unifiedTotal?.marketValue ?? null,
              })
            : null,
        totalReturnPct: computeTotalReturnPct({
          ctx: metricsCtx,
          securityId: row.securityId,
          currentMV: row.totalMarketValue,
          costBasis: row.totalCostBasis,
        }),
      };
    });

    const todayDelta = computeUnifiedTodayDelta({
      ctx: metricsCtx,
      holdings: rows.map((r) => ({
        securityId: r.securityId,
        quantity: r.totalQuantity,
        currency: r.currency,
      })),
    });
    const unifiedTotalWithDelta = unifiedTotal
      ? { ...unifiedTotal, todayChangePct: todayDelta.todayChangePct, todayChangeCad: todayDelta.todayChangeCad }
      : null;

    res.json({ rows: rowsWithMetrics, unifiedTotal: unifiedTotalWithDelta });
  } catch (e) {
    next(e);
  }
});

/**
 * Run the ACB engine once per (accountId, securityId) pair that has
 * at least one SELL within scope. Returns the realized events plus
 * lookups for symbol/account name.
 */
type RealizedRunRow = {
  accountId: number;
  accountName: string;
  securityId: number;
  symbol: string;
  name: string | null;
  acb: AcbResult;
};

async function runAcbForSells(
  accounts: Account[],
  dateFrom: string | null,
  dateTo: string | null
): Promise<RealizedRunRow[]> {
  const accountIds = accounts.map((a) => a.id);
  if (accountIds.length === 0) return [];
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  // We need ALL buy+sell activities for any (account, security) pair
  // that has a SELL inside the date window — otherwise ACB-per-unit
  // would be wrong. So: first find the pairs with SELLs in range,
  // then load every activity for those pairs (no date filter on the
  // ACB run itself, but realized events get filtered by date below).
  const sellWhere: Record<string, unknown> = {
    accountId: accountIds,
    activityType: 'sell',
    securityId: { [Op.ne]: null },
  };
  if (dateFrom || dateTo) {
    const cond: Record<symbol, string> = {};
    if (dateFrom) cond[Op.gte] = dateFrom;
    if (dateTo) cond[Op.lte] = dateTo;
    sellWhere.tradeDate = cond;
  }
  const sells = await InvestmentActivity.findAll({ where: sellWhere });
  const pairs = new Set<string>();
  for (const s of sells) {
    if (s.securityId == null) continue;
    pairs.add(`${s.accountId}:${s.securityId}`);
  }
  if (pairs.size === 0) return [];

  // Load every BUY+SELL activity for those pairs (no date filter, so
  // ACB walks from the start of the position).
  const conditions = [...pairs].map((p) => {
    const [a, s] = p.split(':').map(Number);
    return { accountId: a, securityId: s };
  });
  const allActivities = await InvestmentActivity.findAll({
    where: {
      [Op.or]: conditions,
      activityType: [
        'buy',
        'sell',
        'reinvestment',
        'split',
        'return_of_capital',
        'transfer_in',
        'transfer_out',
      ],
    },
    include: [{ model: Security, as: 'security' }],
    order: [
      ['tradeDate', 'ASC'],
      ['id', 'ASC'],
    ],
  });

  // Group by (account, security) and run ACB.
  const grouped = new Map<string, InvestmentActivity[]>();
  for (const row of allActivities) {
    if (row.securityId == null) continue;
    const key = `${row.accountId}:${row.securityId}`;
    const existing = grouped.get(key);
    if (existing) existing.push(row);
    else grouped.set(key, [row]);
  }

  const out: RealizedRunRow[] = [];
  for (const [key, rows] of grouped) {
    const [accId, secId] = key.split(':').map(Number);
    const security = rows[0].get('security') as Security | undefined;
    if (!security) continue;
    const acbInput: AcbActivity[] = rows.map((r) => ({
      id: r.id,
      tradeDate: r.tradeDate,
      activityType: r.activityType,
      quantity: n(r.quantity),
      amount: n(r.amount),
      currency: r.currency,
      fees: n(r.fees),
      splitRatio: n(r.splitRatio),
    }));
    const { normalized, warnings: fxWarnings } =
      await normalizeActivitiesToCad(acbInput);
    const acb = computeAcb(normalized);
    acb.warnings.push(...fxWarnings);
    // Filter realized events by date range, if requested.
    if (dateFrom || dateTo) {
      acb.realizedEvents = acb.realizedEvents.filter((e) => {
        if (dateFrom && e.tradeDate < dateFrom) return false;
        if (dateTo && e.tradeDate > dateTo) return false;
        return true;
      });
      acb.realizedTotal = acb.realizedEvents.reduce((sum, e) => sum + e.realizedGain, 0);
    }
    out.push({
      accountId: accId,
      accountName: accountById.get(accId)?.name ?? String(accId),
      securityId: secId,
      symbol: security.symbol,
      name: security.name,
      acb,
    });
  }
  return out;
}

/**
 * GET /api/portfolio/realized — realized gain/loss summary.
 */
router.get('/realized', async (req, res, next) => {
  try {
    const accounts = await Account.findAll({
      where: { ...visibleAccountWhere(req), accountType: 'investment' },
      order: [['name', 'ASC']],
    });
    const { dateFrom, dateTo } = parseDateRange(req);
    const runs = await runAcbForSells(accounts, dateFrom, dateTo);

    type Totals = { currency: string; realizedGain: number; eventCount: number };
    const totals = new Map<string, Totals>();
    type SecRow = {
      securityId: number;
      symbol: string;
      name: string | null;
      currency: string;
      realizedGain: number;
      eventCount: number;
    };
    const bySec = new Map<string, SecRow>();
    const events: Array<{
      activityId: number;
      securityId: number;
      symbol: string;
      tradeDate: string;
      qtySold: number;
      proceeds: number;
      acbAtSale: number;
      realizedGain: number;
      currency: string;
      accountId: number;
      accountName: string;
    }> = [];

    for (const run of runs) {
      for (const e of run.acb.realizedEvents) {
        const t = totals.get(e.currency) ?? {
          currency: e.currency,
          realizedGain: 0,
          eventCount: 0,
        };
        t.realizedGain += e.realizedGain;
        t.eventCount += 1;
        totals.set(e.currency, t);

        const secKey = `${run.securityId}|${e.currency}`;
        const sr = bySec.get(secKey) ?? {
          securityId: run.securityId,
          symbol: run.symbol,
          name: run.name,
          currency: e.currency,
          realizedGain: 0,
          eventCount: 0,
        };
        sr.realizedGain += e.realizedGain;
        sr.eventCount += 1;
        bySec.set(secKey, sr);

        events.push({
          activityId: e.activityId,
          securityId: run.securityId,
          symbol: run.symbol,
          tradeDate: e.tradeDate,
          qtySold: e.qtySold,
          proceeds: e.proceeds,
          acbAtSale: e.acbPerUnitAtSale,
          realizedGain: e.realizedGain,
          currency: e.currency,
          accountId: run.accountId,
          accountName: run.accountName,
        });
      }
    }

    events.sort((a, b) => (a.tradeDate === b.tradeDate ? a.activityId - b.activityId : a.tradeDate.localeCompare(b.tradeDate)));

    res.json({
      totals: [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
      bySecurity: [...bySec.values()].sort((a, b) => b.realizedGain - a.realizedGain),
      events,
    });
  } catch (e) {
    next(e);
  }
});

type PriceRange = '1m' | '3m' | '1y' | '5y' | 'all';
const PRICE_RANGES: Record<PriceRange, number | null> = {
  '1m': 30,
  '3m': 92,
  '1y': 365,
  '5y': 365 * 5,
  all: null,
};

function parseRange(raw: unknown): PriceRange {
  if (typeof raw === 'string' && raw in PRICE_RANGES) return raw as PriceRange;
  return '1y';
}

async function loadSecurityScoped(req: Request, idRaw: string) {
  const id = Number(idRaw);
  if (!Number.isFinite(id) || id <= 0) return { error: 400 as const };
  const security = await Security.findByPk(id);
  if (!security) return { error: 404 as const };
  // Household scoping: a security must have at least one activity OR holding
  // visible to the caller. Reuse visibleAccountWhere for the account scope.
  const accounts = await Account.findAll({
    where: { ...visibleAccountWhere(req), accountType: 'investment' },
  });
  const accountIds = accounts.map((a) => a.id);
  if (accountIds.length === 0) return { error: 404 as const };
  const activityCount = await InvestmentActivity.count({
    where: { accountId: accountIds, securityId: id },
  });
  const holdingCount = await HoldingSnapshot.count({
    where: { accountId: accountIds, securityId: id },
  });
  if (activityCount === 0 && holdingCount === 0) return { error: 404 as const };
  return { security, accountIds };
}

/**
 * GET /api/portfolio/security/:id/prices — OHLCV history + trade overlays.
 */
router.get('/security/:id/prices', async (req, res, next) => {
  try {
    const scoped = await loadSecurityScoped(req, req.params.id);
    if ('error' in scoped) {
      res.status(scoped.error as number).json({ error: 'Security not visible' });
      return;
    }
    const { security, accountIds } = scoped;
    const range = parseRange(req.query.range);
    const days = PRICE_RANGES[range];

    const where: Record<string, unknown> = { securityId: security.id };
    if (days != null) {
      const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
      where.date = { [Op.gte]: cutoff };
    }
    const rows = await SecurityDailyPrice.findAll({
      where,
      order: [['date', 'ASC']],
    });

    // Trades filtered to same date window for overlay.
    const tradeWhere: Record<string, unknown> = {
      accountId: accountIds,
      securityId: security.id,
      activityType: ['buy', 'sell'],
    };
    if (days != null) {
      const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
      tradeWhere.tradeDate = { [Op.gte]: cutoff };
    }
    const trades = await InvestmentActivity.findAll({
      where: tradeWhere,
      include: [{ model: Account, as: 'account' }],
      order: [['tradeDate', 'ASC']],
    });

    const backfill = await ensureDailyPrices(security.id);

    res.json({
      securityId: security.id,
      symbol: security.symbol,
      currency: security.currency,
      range,
      rows: rows.map((r) => ({
        date: r.date,
        open: r.open != null ? Number(r.open) : null,
        high: r.high != null ? Number(r.high) : null,
        low: r.low != null ? Number(r.low) : null,
        close: Number(r.close),
        adjClose: Number(r.adjClose),
        volume: r.volume,
      })),
      trades: trades.map((t) => ({
        date: t.tradeDate,
        type: t.activityType as 'buy' | 'sell',
        quantity: t.quantity != null ? Number(t.quantity) : 0,
        price: t.price != null ? Number(t.price) : null,
        accountName: (t as unknown as { account?: { name: string } }).account?.name ?? '',
      })),
      backfill,
    });
  } catch (e) {
    next(e);
  }
});

router.get('/security/:id/dividends', async (req, res, next) => {
  try {
    const scoped = await loadSecurityScoped(req, req.params.id);
    if ('error' in scoped) {
      res.status(scoped.error as number).json({ error: 'Security not visible' });
      return;
    }
    const { security } = scoped;
    const events = await SecurityDividend.findAll({
      where: { securityId: security.id },
      order: [['exDividendDate', 'ASC']],
    });
    const backfill = await ensureDividends(security.id);
    res.json({
      securityId: security.id,
      currency: security.currency,
      events: events.map((e) => ({
        exDividendDate: e.exDividendDate,
        paymentDate: e.paymentDate,
        recordDate: e.recordDate,
        amount: Number(e.amount),
        currency: e.currency,
      })),
      backfill,
    });
  } catch (e) {
    next(e);
  }
});

router.get('/security/:id/overview', async (req, res, next) => {
  try {
    const scoped = await loadSecurityScoped(req, req.params.id);
    if ('error' in scoped) {
      res.status(scoped.error as number).json({ error: 'Security not visible' });
      return;
    }
    const { security } = scoped;
    const m = (security.metadata ?? {}) as Record<string, unknown>;
    const backfill = await ensureOverview(security.id);
    res.json({
      securityId: security.id,
      sector: m['sector'] ?? null,
      industry: m['industry'] ?? null,
      country: m['country'] ?? null,
      exchange: m['exchange'] ?? null,
      description: m['description'] ?? null,
      metadataFetchedAt: security.metadataFetchedAt?.toISOString() ?? null,
      backfill,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/portfolio/security/:id — full per-security drill payload.
 */
router.get('/security/:id', async (req, res, next) => {
  try {
    const securityId = Number(req.params.id);
    if (!Number.isFinite(securityId) || securityId <= 0) {
      res.status(400).json({ error: 'Invalid security id' });
      return;
    }
    const security = await Security.findByPk(securityId);
    if (!security) {
      res.status(404).json({ error: 'Security not found' });
      return;
    }
    const accounts = await Account.findAll({
      where: { ...visibleAccountWhere(req), accountType: 'investment' },
      order: [['name', 'ASC']],
    });
    const accountIds = accounts.map((a) => a.id);
    const accountById = new Map(accounts.map((a) => [a.id, a]));
    if (accountIds.length === 0) {
      res.status(404).json({ error: 'Security not visible' });
      return;
    }

    // All activities for this security across visible accounts.
    const allActivities = await InvestmentActivity.findAll({
      where: { accountId: accountIds, securityId },
      order: [
        ['tradeDate', 'ASC'],
        ['id', 'ASC'],
      ],
    });
    // All holdings (every snapshot, all dates).
    const allHoldings = await HoldingSnapshot.findAll({
      where: { accountId: accountIds, securityId },
      order: [
        ['statementDate', 'DESC'],
        ['id', 'DESC'],
      ],
    });
    if (allActivities.length === 0 && allHoldings.length === 0) {
      res.status(404).json({ error: 'Security not visible' });
      return;
    }

    const priceMap = await latestPricesBySecurity([securityId]);
    const latestPrice = priceMap.get(securityId);

    // Latest holding per account (for current snapshot fields).
    const latestByAccount = new Map<number, HoldingSnapshot>();
    for (const h of allHoldings) {
      if (!latestByAccount.has(h.accountId)) latestByAccount.set(h.accountId, h);
    }

    // Group activities by account.
    const actsByAccount = new Map<number, InvestmentActivity[]>();
    for (const a of allActivities) {
      const list = actsByAccount.get(a.accountId) ?? [];
      list.push(a);
      actsByAccount.set(a.accountId, list);
    }

    const involvedAccountIds = new Set<number>([
      ...latestByAccount.keys(),
      ...actsByAccount.keys(),
    ]);

    type PerAccount = {
      accountId: number;
      accountName: string;
      currentQuantity: number;
      currentMarketValue: number;
      currentCostBasis: number;
      currentUnrealizedGainLoss: number | null;
      acb: AcbResult;
    };
    const perAccount: PerAccount[] = [];
    let combinedQty = 0;
    let combinedMv = 0;
    let combinedCost = 0;
    let combinedRealized = 0;
    let combinedDividend = 0;
    let combinedInterest = 0;
    let combinedCurrency = security.currency;

    for (const accId of involvedAccountIds) {
      const acctName = accountById.get(accId)?.name ?? String(accId);
      const latestHolding = latestByAccount.get(accId);
      const acts = actsByAccount.get(accId) ?? [];
      const acbInput: AcbActivity[] = acts.map((r) => ({
        id: r.id,
        tradeDate: r.tradeDate,
        activityType: r.activityType,
        quantity: n(r.quantity),
        amount: n(r.amount),
        currency: r.currency,
        fees: n(r.fees),
        splitRatio: n(r.splitRatio),
      }));
      const { normalized, warnings: fxWarnings } =
        await normalizeActivitiesToCad(acbInput);
      const acb = computeAcb(normalized);
      acb.warnings.push(...fxWarnings);

      const currentQuantity = latestHolding ? n(latestHolding.quantity) ?? 0 : 0;
      const { marketValue: currentMarketValue, currency: holdingCurrency } = latestHolding
        ? valueHolding(latestHolding, latestPrice)
        : { marketValue: 0, currency: security.currency };
      const currentCostBasis = latestHolding ? n(latestHolding.costBasis) ?? 0 : 0;
      const currentUnrealizedGainLoss =
        latestHolding && currentCostBasis !== 0
          ? currentMarketValue - currentCostBasis
          : null;

      perAccount.push({
        accountId: accId,
        accountName: acctName,
        currentQuantity,
        currentMarketValue,
        currentCostBasis,
        currentUnrealizedGainLoss,
        acb,
      });

      combinedQty += currentQuantity;
      combinedMv += currentMarketValue;
      combinedCost += currentCostBasis;
      // TODO(acb-fx-followup): combinedRealized naively sums across currencies;
      // mixed-currency positions need per-currency rollup. Out of scope here.
      combinedRealized += acb.realizedTotal;
      if (holdingCurrency) combinedCurrency = holdingCurrency;
      for (const r of acts) {
        const amt = Math.abs(n(r.amount) ?? 0);
        if (r.activityType === 'dividend') combinedDividend += amt;
        else if (r.activityType === 'interest') combinedInterest += amt;
      }
    }

    const activitiesDto = allActivities.map((a) => ({
      id: a.id,
      accountId: a.accountId,
      accountName: accountById.get(a.accountId)?.name ?? String(a.accountId),
      activityType: a.activityType,
      tradeDate: a.tradeDate,
      settlementDate: a.settlementDate,
      description: a.description,
      quantity: n(a.quantity),
      price: n(a.price),
      amount: n(a.amount),
      fees: n(a.fees),
      currency: a.currency,
    }));
    const holdingsDto = allHoldings.map((h) => ({
      id: h.id,
      accountId: h.accountId,
      accountName: accountById.get(h.accountId)?.name ?? String(h.accountId),
      statementDate: h.statementDate,
      quantity: n(h.quantity) ?? 0,
      price: n(h.price),
      marketValue: n(h.marketValue),
      costBasis: n(h.costBasis),
      unrealizedGainLoss: n(h.unrealizedGainLoss),
      currency: h.currency,
    }));

    // Today change %: needs current price + prevClose. Use latest SecurityPrice quote
    // (refreshed via /prices/refresh). prevClose comes from yesterday's adj_close.
    const dailyForToday = await SecurityDailyPrice.findAll({
      where: { securityId },
      order: [['date', 'DESC']],
      limit: 2,
    });
    const todayPriceQuote = latestPrice ? Number(latestPrice.price) : null;
    const prevClose = dailyForToday[0] ? Number(dailyForToday[0].adjClose) : null;
    const todayChangePct =
      todayPriceQuote != null && prevClose != null && prevClose !== 0
        ? ((todayPriceQuote - prevClose) / prevClose) * 100
        : null;

    // 30-day return %: ((todayPrice + dividends_in_30d_per_unit) - price_30d_ago) / price_30d_ago
    const cutoff30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const price30 = await SecurityDailyPrice.findOne({
      where: { securityId, date: { [Op.lte]: cutoff30 } },
      order: [['date', 'DESC']],
    });
    const divs30 = await SecurityDividend.findAll({
      where: { securityId, exDividendDate: { [Op.gte]: cutoff30 } },
    });
    const divPerUnit30 = divs30.reduce((s, d) => s + Number(d.amount), 0);
    const price30Val = price30 ? Number(price30.adjClose) : null;
    const todayForReturn = todayPriceQuote ?? (dailyForToday[0] ? Number(dailyForToday[0].adjClose) : null);
    const thirtyDayReturnPct =
      price30Val != null && price30Val !== 0 && todayForReturn != null
        ? ((todayForReturn + divPerUnit30 - price30Val) / price30Val) * 100
        : null;

    // Yield on cost (TTM)
    const cutoff365 = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
    const divs365 = await SecurityDividend.findAll({
      where: { securityId, exDividendDate: { [Op.gte]: cutoff365 } },
    });
    const divPerUnit365 = divs365.reduce((s, d) => s + Number(d.amount), 0);
    const yieldOnCostPct =
      combinedCost > 0 && combinedQty > 0
        ? ((divPerUnit365 * combinedQty) / combinedCost) * 100
        : null;

    res.json({
      security: {
        id: security.id,
        symbol: security.symbol,
        name: security.name,
        assetType: security.assetType,
        currency: security.currency,
      },
      perAccount,
      combined: {
        currentQuantity: combinedQty,
        currentMarketValue: combinedMv,
        currentCostBasis: combinedCost,
        realizedTotal: combinedRealized,
        income: { dividend: combinedDividend, interest: combinedInterest },
        currency: combinedCurrency,
        todayChangePct,
        thirtyDayReturnPct,
        yieldOnCostPct,
      },
      activities: activitiesDto,
      holdings: holdingsDto,
      latestPrice: latestPrice
        ? {
            price: n(latestPrice.price) ?? 0,
            pricedAt: latestPrice.pricedAt.toISOString(),
            provider: latestPrice.provider,
            currency: latestPrice.currency,
          }
        : null,
    });
  } catch (e) {
    next(e);
  }
});

router.get('/sparklines', async (req, res, next) => {
  try {
    const rawRange = req.query.range;
    if (rawRange !== undefined && rawRange !== '30d') {
      res.status(400).json({ error: 'Unsupported range; only "30d" is currently supported' });
      return;
    }

    const accounts = await Account.findAll({
      where: { ...visibleAccountWhere(req), accountType: 'investment' },
      attributes: ['id'],
    });
    const accountIds = accounts.map((a) => a.id);
    if (accountIds.length === 0) {
      res.json({ range: '30d', bySecurityId: {} });
      return;
    }

    // Securities the caller actually has activity or holdings for.
    const [activitySecIds, holdingSecIds] = await Promise.all([
      InvestmentActivity.findAll({
        where: { accountId: accountIds, securityId: { [Op.ne]: null as any } },
        attributes: ['securityId'],
        group: ['securityId'],
      }),
      HoldingSnapshot.findAll({
        where: { accountId: accountIds, securityId: { [Op.ne]: null as any } },
        attributes: ['securityId'],
        group: ['securityId'],
      }),
    ]);
    const securityIds = Array.from(
      new Set(
        [
          ...activitySecIds.map((a) => a.securityId),
          ...holdingSecIds.map((h) => h.securityId),
        ].filter((id): id is number => typeof id === 'number'),
      ),
    );
    if (securityIds.length === 0) {
      res.json({ range: '30d', bySecurityId: {} });
      return;
    }

    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const rows = await SecurityDailyPrice.findAll({
      where: {
        securityId: securityIds,
        date: { [Op.gte]: cutoff },
      },
      order: [['securityId', 'ASC'], ['date', 'ASC']],
    });

    const bySecurityId: Record<number, Array<{ date: string; close: number }>> = {};
    for (const row of rows) {
      const arr = bySecurityId[row.securityId] ?? (bySecurityId[row.securityId] = []);
      arr.push({ date: row.date, close: Number(row.adjClose) });
    }

    res.json({ range: '30d', bySecurityId });
  } catch (e) {
    next(e);
  }
});

router.get('/by-account-type', async (req, res, next) => {
  try {
    const accounts = await Account.findAll({
      where: { ...visibleAccountWhere(req), accountType: 'investment' },
      order: [['name', 'ASC']],
    });
    if (accounts.length === 0) {
      res.json({ buckets: [], warnings: [], harvestCandidates: [] });
      return;
    }
    const accountIds = accounts.map((a) => a.id);
    const accountById = new Map(accounts.map((a) => [a.id, a]));

    const { latestHoldings } = await loadVisibleLatestHoldings(req);
    const securityIdsRaw = [...new Set(latestHoldings.map((h) => h.securityId))];

    const securities = await Security.findAll({ where: { id: securityIdsRaw } });
    const securityById = new Map(securities.map((s) => [s.id, s]));

    const prices = await latestPricesBySecurity(securityIdsRaw);
    const currencies = [...new Set(latestHoldings.map((h) => {
      const lp = prices.get(h.securityId);
      return (lp?.currency ?? h.currency) as string;
    }))];
    const metricsCtx = await loadMetricsContext({
      securityIds: securityIdsRaw,
      currencies,
      accountIds,
    });

    const dividendRows = await SecurityDividend.findAll({
      where: { securityId: securityIdsRaw },
      attributes: ['securityId'],
      group: ['securityId'],
    });
    const hasDividendsSet = new Set(dividendRows.map((d) => d.securityId));

    type BucketRow = {
      securityId: number
      symbol: string
      name: string | null
      assetType: string | null
      accountId: number
      accountName: string
      quantity: number
      currency: string
      marketValue: number
      marketValueCad: number | null
      costBasis: number | null
      unrealizedGainCad: number | null
      weightInBucketPct: number | null
      flags: RowFlag[]
    };

    type Bucket = {
      taxStatus: typeof TAX_STATUS_ORDER[number]
      label: string
      accounts: Array<{ id: number; name: string; currency: string }>
      holdingsCount: number
      totalCadMV: number | null
      allocationByAssetType: Array<{ assetType: string | null; marketValueCad: number; percentage: number }>
      rows: BucketRow[]
    };

    const bucketMap = new Map<string, Bucket>();
    for (const acct of accounts) {
      const taxStatus = (acct.taxStatus ?? 'n_a') as typeof TAX_STATUS_ORDER[number];
      let bucket = bucketMap.get(taxStatus);
      if (!bucket) {
        bucket = {
          taxStatus,
          label: TAX_STATUS_LABELS[taxStatus],
          accounts: [],
          holdingsCount: 0,
          totalCadMV: 0,
          allocationByAssetType: [],
          rows: [],
        };
        bucketMap.set(taxStatus, bucket);
      }
      bucket.accounts.push({
        id: acct.id,
        name: acct.name,
        currency: acct.defaultCurrency ?? 'CAD',
      });
    }

    const warnings: Array<{ kind: RowFlag; securityId: number; symbol: string; accountName: string; text: string }> = [];

    for (const holding of latestHoldings) {
      const security = securityById.get(holding.securityId);
      const account = accountById.get(holding.accountId);
      if (!security || !account) continue;
      const acctTaxStatus = (account.taxStatus ?? 'n_a') as typeof TAX_STATUS_ORDER[number];
      const bucket = bucketMap.get(acctTaxStatus);
      if (!bucket) continue;

      const latestPrice = prices.get(holding.securityId);
      const { marketValue, currency } = valueHolding(holding, latestPrice);
      const qty = n(holding.quantity) ?? 0;
      const cost = n(holding.costBasis);
      const fxRate = currency === 'CAD' ? 1 : metricsCtx.fxRates.get(currency);
      const marketValueCad = fxRate != null ? marketValue * fxRate : null;
      const costBasisCad = fxRate != null && cost != null ? cost * fxRate : null;
      const unrealizedGainCad =
        marketValueCad != null && costBasisCad != null ? marketValueCad - costBasisCad : null;

      const flags = rowFlags({
        security: {
          symbol: security.symbol,
          currency: security.currency,
          assetType: security.assetType,
          metadata: (security.metadata ?? null) as Record<string, unknown> | null,
        },
        account: { taxStatus: acctTaxStatus },
        hasDividends: hasDividendsSet.has(security.id),
      });

      bucket.rows.push({
        securityId: security.id,
        symbol: security.symbol,
        name: security.name,
        assetType: security.assetType,
        accountId: holding.accountId,
        accountName: account.name,
        quantity: qty,
        currency,
        marketValue,
        marketValueCad,
        costBasis: cost,
        unrealizedGainCad,
        weightInBucketPct: null,
        flags,
      });
      bucket.holdingsCount += 1;

      if (bucket.totalCadMV != null && marketValueCad != null) {
        bucket.totalCadMV += marketValueCad;
      } else {
        bucket.totalCadMV = null;
      }

      for (const flag of flags) {
        if (flag === 'fixed_income_in_non_reg' || flag === 'us_payer_in_tfsa') {
          warnings.push({
            kind: flag,
            securityId: security.id,
            symbol: security.symbol,
            accountName: account.name,
            text:
              flag === 'fixed_income_in_non_reg'
                ? `Fixed income (${security.symbol}) held in non-registered account ${account.name} — consider moving to a registered account.`
                : `US dividend payer (${security.symbol}) held in TFSA ${account.name} — 15% US withholding tax cannot be recovered.`,
          });
        }
      }
    }

    for (const bucket of bucketMap.values()) {
      if (bucket.totalCadMV != null && bucket.totalCadMV > 0) {
        for (const row of bucket.rows) {
          if (row.marketValueCad != null) {
            row.weightInBucketPct = (row.marketValueCad / bucket.totalCadMV) * 100;
          }
        }
      }
      const byAssetType = new Map<string, number>();
      let allocatableTotal = 0;
      for (const row of bucket.rows) {
        if (row.marketValueCad == null) continue;
        const key = row.assetType ?? 'Other';
        byAssetType.set(key, (byAssetType.get(key) ?? 0) + row.marketValueCad);
        allocatableTotal += row.marketValueCad;
      }
      bucket.allocationByAssetType = [...byAssetType.entries()].map(([assetType, marketValueCad]) => ({
        assetType: assetType === 'Other' ? null : assetType,
        marketValueCad,
        percentage: allocatableTotal > 0 ? (marketValueCad / allocatableTotal) * 100 : 0,
      }));
    }

    const buckets = TAX_STATUS_ORDER
      .map((status) => bucketMap.get(status))
      .filter((b): b is Bucket => b != null);

    const nrBucket = bucketMap.get('non_registered');
    const candidatesRaw = (nrBucket?.rows ?? [])
      .map((row) => {
        const c = harvestCandidate({
          securityId: row.securityId,
          symbol: row.symbol,
          accountId: row.accountId,
          accountName: row.accountName,
          costBasisCad: row.unrealizedGainCad != null && row.marketValueCad != null
            ? row.marketValueCad - row.unrealizedGainCad
            : null,
          marketValueCad: row.marketValueCad,
        });
        if (!c) return null;
        return { row, unrealizedLossCad: c.unrealizedLossCad };
      })
      .filter((x): x is { row: BucketRow; unrealizedLossCad: number } => x != null);

    const windowStart = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const windowEnd = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const candidateSecIds = candidatesRaw.map((c) => c.row.securityId);
    const recentBuys = candidateSecIds.length > 0
      ? await InvestmentActivity.findAll({
          where: {
            accountId: accountIds,
            securityId: candidateSecIds,
            activityType: ['buy', 'reinvestment'],
            tradeDate: { [Op.between]: [windowStart, windowEnd] },
          },
          attributes: ['securityId', 'accountId', 'tradeDate'],
        })
      : [];
    const buysBySec = new Map<number, Array<{ accountId: number; tradeDate: string }>>();
    for (const b of recentBuys) {
      const sid = b.securityId;
      if (sid == null) continue;
      const arr = buysBySec.get(sid) ?? [];
      arr.push({ accountId: b.accountId, tradeDate: b.tradeDate });
      buysBySec.set(sid, arr);
    }

    const harvestCandidates = candidatesRaw.map(({ row, unrealizedLossCad }) => {
      const buys = buysBySec.get(row.securityId) ?? [];
      const superficialLossWarning = buys.length > 0;
      const detail = superficialLossWarning
        ? `Buy/reinvestment in ${buys.map((b) => {
            const acctName = accountById.get(b.accountId)?.name ?? `account ${b.accountId}`;
            return `${acctName} on ${b.tradeDate}`;
          }).join('; ')} within ±30 days of today.`
        : null;
      return {
        securityId: row.securityId,
        symbol: row.symbol,
        accountId: row.accountId,
        accountName: row.accountName,
        unrealizedLossCad,
        superficialLossWarning,
        superficialLossDetail: detail,
      };
    });

    res.json({ buckets, warnings, harvestCandidates });
  } catch (e) {
    next(e);
  }
});

router.post('/prices/refresh', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
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
      const candidates = enumerateYahooSymbols(security.symbol, {
        currency: security.currency,
        assetType: security.assetType,
        name: security.name,
      });
      let quoteSettled = false;
      for (let i = 0; i < candidates.length && !quoteSettled; i++) {
        const yahooSymbol = candidates[i];
        const isLast = i === candidates.length - 1;
        try {
          const quote = await fetchQuote(yahooSymbol);
          if (!quote) {
            await recordCall({
              function: 'QUOTE',
              symbol: yahooSymbol,
              status: 'not_found',
            });
            if (isLast) {
              results.push({ symbol: security.symbol, status: 'not_found' });
              quoteSettled = true;
            }
            continue;
          }
          const row = await SecurityPrice.create({
            securityId: security.id,
            provider: YAHOO_PROVIDER,
            symbol: security.symbol,
            pricedAt: quote.pricedAt,
            price: String(quote.price),
            currency: security.currency,
            fetchedAt: new Date(),
          });
          await recordCall({
            function: 'QUOTE',
            symbol: yahooSymbol,
            status: 'ok',
          });
          results.push({
            symbol: security.symbol,
            status: 'refreshed',
            price: quote.price,
            fetchedAt: row.fetchedAt.toISOString(),
          });
          quoteSettled = true;
        } catch (e) {
          const message = e instanceof Error ? e.message : 'Quote refresh failed';
          const isProviderErr = e instanceof YahooFinanceError;
          const isRateLimit =
            isProviderErr && (e.httpStatus === 429 || /rate.?limit/i.test(e.message));
          await recordCall({
            function: 'QUOTE',
            symbol: yahooSymbol,
            status: isRateLimit ? 'rate_limited' : 'error',
            httpStatus: isProviderErr ? e.httpStatus : null,
            errorMessage: message.slice(0, 1024),
          });
          results.push({
            symbol: security.symbol,
            status: isRateLimit ? 'rate_limited' : 'error',
            error: message,
          });
          quoteSettled = true;
        }
      }
    }
    res.json({ provider: YAHOO_PROVIDER, results });
  } catch (e) {
    next(e);
  }
});

router.get('/forward-income', async (req, res, next) => {
  try {
    const auth = currentAuth(req);
    const householdId = auth.household.id;

    // 1. Trigger lazy rebuild if any row stale, or no rows yet but household has holdings
    const [staleCount, totalRows, holdingsResult] = await Promise.all([
      PortfolioForwardProjection.count({
        where: { householdId, staleAt: { [Op.ne]: null } },
      }),
      PortfolioForwardProjection.count({ where: { householdId } }),
      loadVisibleLatestHoldings(req),
    ]);
    const { latestHoldings, accounts } = holdingsResult;
    if (staleCount > 0 || (totalRows === 0 && latestHoldings.length > 0)) {
      await rebuildForwardProjectionsForHousehold(householdId);
    }

    // 2. Reload after rebuild
    const rows = await PortfolioForwardProjection.findAll({ where: { householdId } });
    const securityIds = rows.map((r) => r.securityId);
    const securities = await Security.findAll({ where: { id: securityIds } });
    const secById = new Map(securities.map((s) => [s.id, s]));
    const acctById = new Map(accounts.map((a) => [a.id, a]));

    // 3. Per-security qty totals + per (account, security) qty for apportionment
    interface AcctSecPair { accountId: number; securityId: number; qty: number; mvNative: number; costNative: number; currency: string; taxStatus: string; }
    const pairs: AcctSecPair[] = [];
    const totalQtyBySec = new Map<number, number>();
    const totalMvBySec = new Map<number, number>();
    const totalCostBySec = new Map<number, number>();
    for (const h of latestHoldings) {
      const qty = Number(h.quantity);
      if (qty === 0) continue;
      const mv = Number(h.marketValue ?? 0);
      const cost = Number(h.costBasis ?? 0);
      const acct = acctById.get(h.accountId);
      const taxStatus = acct?.taxStatus ?? 'n_a';
      pairs.push({
        accountId: h.accountId, securityId: h.securityId, qty,
        mvNative: mv, costNative: cost, currency: h.currency, taxStatus,
      });
      totalQtyBySec.set(h.securityId, (totalQtyBySec.get(h.securityId) ?? 0) + qty);
      totalMvBySec.set(h.securityId, (totalMvBySec.get(h.securityId) ?? 0) + mv);
      totalCostBySec.set(h.securityId, (totalCostBySec.get(h.securityId) ?? 0) + cost);
    }

    // 4. FX rates per currency (today)
    const asOf = new Date();
    const asOfDate = asOf.toISOString().slice(0, 10);
    const fxByCurrency = new Map<string, number>();
    fxByCurrency.set('CAD', 1);
    for (const r of rows) {
      if (r.currency !== 'CAD' && !fxByCurrency.has(r.currency)) {
        const fx = await ensureFxRate(r.currency, 'CAD', asOfDate);
        fxByCurrency.set(r.currency, fx ? Number(fx.rate) : 1);
      }
    }

    // 5. Build per-row output + accumulate totals
    let totalAnnualCad = 0;
    let totalMvCad = 0;
    let totalCostCad = 0;
    const byCurrencyTotal = new Map<string, number>();
    const outRows = rows.map((r) => {
      const sec = secById.get(r.securityId);
      const qty = totalQtyBySec.get(r.securityId) ?? Number(r.qtyBasis);
      const mvNative = totalMvBySec.get(r.securityId) ?? 0;
      const costNative = totalCostBySec.get(r.securityId) ?? 0;
      const fx = fxByCurrency.get(r.currency) ?? 1;
      const projNative = Number(r.projectedAnnualIncomeNative);
      const projCad = projNative * fx;
      const forwardYieldPct = mvNative > 0 ? (projNative / mvNative) * 100 : 0;
      const forwardYieldOnCostPct = costNative > 0 ? (projNative / costNative) * 100 : 0;
      totalAnnualCad += projCad;
      totalMvCad += mvNative * fx;
      totalCostCad += costNative * fx;
      byCurrencyTotal.set(r.currency, (byCurrencyTotal.get(r.currency) ?? 0) + projNative);
      return {
        securityId: r.securityId,
        symbol: sec?.symbol ?? '',
        name: sec?.name ?? '',
        assetType: sec?.assetType ?? null,
        currency: r.currency,
        qty,
        currentMvNative: mvNative,
        costBasisNative: costNative,
        annualDividendPerShare: Number(r.annualDividendPerShare),
        annualInterestPerShare: Number(r.annualInterestPerShare),
        projectedAnnualIncomeNative: projNative,
        projectedAnnualIncomeCad: projCad,
        forwardYieldPct,
        forwardYieldOnCostPct,
        cadenceLabel: r.cadenceLabel,
        cvPct: r.cvPct === null ? null : Number(r.cvPct),
        unreliable: r.unreliable,
        nextExDivDates: r.nextExDivDates.map((d) => ({
          date: d.date,
          estimatedPerShare: d.estimatedPerShare,
          estimatedTotal: d.estimatedPerShare * qty,
          kind: d.kind,
        })),
      };
    });

    // 6. byTaxStatus + byAssetType — apportion per-security income across accounts by qty
    const taxMap = new Map<string, Map<string, number>>();
    const assetMap = new Map<string, Map<string, number>>();
    const projBySec = new Map(rows.map((r) => [r.securityId, Number(r.projectedAnnualIncomeNative)]));
    const currencyBySec = new Map(rows.map((r) => [r.securityId, r.currency]));
    for (const p of pairs) {
      const proj = projBySec.get(p.securityId);
      const totalQty = totalQtyBySec.get(p.securityId) ?? 0;
      if (proj == null || totalQty === 0) continue;
      const share = (p.qty / totalQty) * proj;
      const cur = currencyBySec.get(p.securityId) ?? p.currency;
      // tax
      if (!taxMap.has(p.taxStatus)) taxMap.set(p.taxStatus, new Map());
      taxMap.get(p.taxStatus)!.set(cur, (taxMap.get(p.taxStatus)!.get(cur) ?? 0) + share);
      // asset
      const sec = secById.get(p.securityId);
      const assetType = sec?.assetType ?? 'other';
      if (!assetMap.has(assetType)) assetMap.set(assetType, new Map());
      assetMap.get(assetType)!.set(cur, (assetMap.get(assetType)!.get(cur) ?? 0) + share);
    }
    const cadConv = (cur: string, amt: number) => amt * (fxByCurrency.get(cur) ?? 1);
    const byTaxStatus = [...taxMap.entries()].map(([taxStatus, byCur]) => ({
      taxStatus: taxStatus as PortfolioForwardIncome['byTaxStatus'][number]['taxStatus'],
      byCurrency: [...byCur.entries()].map(([currency, amount]) => ({ currency, amount })),
      totalCad: [...byCur.entries()].reduce((s, [c, a]) => s + cadConv(c, a), 0),
    }));
    const byAssetType = [...assetMap.entries()].map(([assetType, byCur]) => ({
      assetType,
      byCurrency: [...byCur.entries()].map(([currency, amount]) => ({ currency, amount })),
      totalCad: [...byCur.entries()].reduce((s, [c, a]) => s + cadConv(c, a), 0),
    }));

    // 7. upcoming90d (flatten + sort)
    const upcoming: PortfolioForwardIncome['upcoming90d'] = [];
    for (const out of outRows) {
      for (const d of out.nextExDivDates) {
        upcoming.push({
          date: d.date,
          securityId: out.securityId,
          symbol: out.symbol,
          estimatedTotalNative: d.estimatedTotal,
          estimatedTotalCad: d.estimatedTotal * (fxByCurrency.get(out.currency) ?? 1),
          currency: out.currency,
          kind: d.kind,
        });
      }
    }
    upcoming.sort((a, b) => a.date.localeCompare(b.date));

    // 8. caveats
    const unreliableSecurityIds = outRows.filter((r) => r.unreliable).map((r) => r.securityId);
    const holdingsWithoutHistory = outRows
      .filter((r) => r.cadenceLabel === 'none')
      .map((r) => ({
        securityId: r.securityId,
        symbol: r.symbol,
        reason: 'no_dividend_history' as const,
      }));

    // 9. totals
    const oldestComputedAt = rows.length === 0
      ? asOf.toISOString()
      : rows.reduce((min, r) => (r.computedAt < min ? r.computedAt : min), rows[0].computedAt).toISOString();

    const response: PortfolioForwardIncome = {
      totals: {
        projectedAnnualIncomeCad: totalAnnualCad,
        projectedAnnualIncomeByCurrency: [...byCurrencyTotal.entries()].map(([currency, amount]) => ({ currency, amount })),
        forwardYieldPct: totalMvCad > 0 ? (totalAnnualCad / totalMvCad) * 100 : 0,
        forwardYieldOnCostPct: totalCostCad > 0 ? (totalAnnualCad / totalCostCad) * 100 : 0,
        computedAt: oldestComputedAt,
        fxRateUsedAt: asOf.toISOString(),
      },
      rows: outRows,
      byTaxStatus,
      byAssetType,
      upcoming90d: upcoming,
      caveats: { unreliableSecurityIds, holdingsWithoutHistory },
    };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

router.get('/performance', async (req, res, next) => {
  try {
    const auth = currentAuth(req);
    const householdId = auth.household.id;
    const householdRow = await Household.findByPk(householdId);
    const benchmarkSymbol = householdRow?.benchmarkSymbol ?? 'SPY';

    const range = (req.query.range as PortfolioPerformanceRange) || '1Y';
    const today = new Date().toISOString().slice(0, 10);

    function addDaysIso(iso: string, days: number): string {
      const d = new Date(iso);
      d.setDate(d.getDate() + days);
      return d.toISOString().slice(0, 10);
    }

    const presetRanges: Record<'1M' | '3M' | 'YTD' | '1Y' | 'All', { from: string; to: string }> = {
      '1M': { from: addDaysIso(today, -30), to: today },
      '3M': { from: addDaysIso(today, -90), to: today },
      'YTD': { from: `${today.slice(0, 4)}-01-01`, to: today },
      '1Y': { from: addDaysIso(today, -365), to: today },
      'All': { from: '1970-01-01', to: today },
    };
    let selectedRange = { from: '', to: '' };
    if (range === 'custom') {
      const from = req.query.from as string | undefined;
      const to = req.query.to as string | undefined;
      if (!from || !to) { res.status(400).json({ error: 'from and to required for custom range' }); return; }
      selectedRange = { from, to };
    } else {
      selectedRange = presetRanges[range as keyof typeof presetRanges];
    }

    const widestFrom = (['1M', '3M', 'YTD', '1Y', 'All'] as const).reduce(
      (min, k) => (presetRanges[k].from < min ? presetRanges[k].from : min),
      selectedRange.from || today,
    );

    const allSnapshots = await PortfolioDailySnapshot.findAll({
      where: { householdId, date: { [Op.gte]: widestFrom, [Op.lte]: selectedRange.to } },
      order: [['date', 'ASC']],
    });

    const computeStats = (from: string, to: string): PortfolioPerformanceStats => {
      const inRange = allSnapshots.filter((s) => s.date >= from && s.date <= to);
      const byDate = new Map<string, { mvCad: number; cashFlowCad: number }>();
      for (const s of inRange) {
        const cur = byDate.get(s.date) ?? { mvCad: 0, cashFlowCad: 0 };
        cur.mvCad += Number(s.marketValueCad);
        cur.cashFlowCad += Number(s.cashFlowCad);
        byDate.set(s.date, cur);
      }
      const points: DailyPoint[] = [...byDate.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, v]) => ({ date, marketValueCad: v.mvCad, cashFlowCad: v.cashFlowCad }));
      const twrPct = computeTwr(points);
      const aggSnaps: AggregatedDailySnapshot[] = points.map((p) => ({
        date: p.date, marketValueCad: p.marketValueCad, cashFlowCad: p.cashFlowCad,
      }));
      const finalMv = points.length > 0 ? points[points.length - 1].marketValueCad : 0;
      const mwrPct = computeXirr(buildCashFlowSeries(aggSnaps, finalMv));

      return {
        twrPct,
        mwrPct,
        benchmarkTwrPct: 0,
        vsBenchmarkDeltaPct: twrPct,
        startDate: points[0]?.date ?? from,
        endDate: points[points.length - 1]?.date ?? to,
        startValueCad: points[0]?.marketValueCad ?? 0,
        endValueCad: finalMv,
        netCashFlowCad: points.reduce((s, p) => s + p.cashFlowCad, 0),
      };
    };

    const benchmarkSecurity = await Security.findOne({ where: { householdId, symbol: benchmarkSymbol } });
    const benchmarkPrices = benchmarkSecurity
      ? await SecurityDailyPrice.findAll({
          where: { securityId: benchmarkSecurity.id, date: { [Op.gte]: widestFrom, [Op.lte]: selectedRange.to } },
          order: [['date', 'ASC']],
        })
      : [];
    const fxByDate = new Map<string, number>();
    if (benchmarkSecurity && benchmarkSecurity.currency !== 'CAD') {
      const fxRows = await FxRate.findAll({
        where: {
          fromCurrency: benchmarkSecurity.currency,
          toCurrency: 'CAD',
          ratedDate: { [Op.gte]: widestFrom, [Op.lte]: selectedRange.to },
        },
      });
      for (const f of fxRows) fxByDate.set(f.ratedDate, Number(f.rate));
    } else if (benchmarkSecurity) {
      benchmarkPrices.forEach((p) => fxByDate.set(p.date, 1));
    }
    const benchmarkIsPartial = !benchmarkSecurity || benchmarkPrices.length === 0;

    const computeBenchmarkStats = (from: string, to: string, initialCad: number) => {
      const inRange = benchmarkPrices
        .filter((p) => p.date >= from && p.date <= to)
        .map((p) => ({ date: p.date, adjClose: Number(p.adjClose) }));
      const series = computeBenchmarkSeries(inRange, fxByDate, initialCad);
      if (series.length < 2) return { twr: 0, series };
      const points: DailyPoint[] = series.map((s) => ({
        date: s.date, marketValueCad: s.valueCad, cashFlowCad: 0,
      }));
      return { twr: computeTwr(points), series };
    };

    const fillBenchmark = (stats: PortfolioPerformanceStats, from: string, to: string): PortfolioPerformanceStats => {
      const { twr } = computeBenchmarkStats(from, to, stats.startValueCad);
      return { ...stats, benchmarkTwrPct: twr, vsBenchmarkDeltaPct: stats.twrPct - twr };
    };

    const presetStats = {
      '1M': fillBenchmark(computeStats(presetRanges['1M'].from, presetRanges['1M'].to), presetRanges['1M'].from, presetRanges['1M'].to),
      '3M': fillBenchmark(computeStats(presetRanges['3M'].from, presetRanges['3M'].to), presetRanges['3M'].from, presetRanges['3M'].to),
      'YTD': fillBenchmark(computeStats(presetRanges['YTD'].from, presetRanges['YTD'].to), presetRanges['YTD'].from, presetRanges['YTD'].to),
      '1Y': fillBenchmark(computeStats(presetRanges['1Y'].from, presetRanges['1Y'].to), presetRanges['1Y'].from, presetRanges['1Y'].to),
      'All': fillBenchmark(computeStats(presetRanges['All'].from, presetRanges['All'].to), presetRanges['All'].from, presetRanges['All'].to),
    };

    const selectedStats = fillBenchmark(
      computeStats(selectedRange.from, selectedRange.to),
      selectedRange.from, selectedRange.to,
    );

    const seriesByDate = new Map<string, { mvCad: number; isPartial: boolean }>();
    for (const s of allSnapshots) {
      if (s.date < selectedRange.from || s.date > selectedRange.to) continue;
      const cur = seriesByDate.get(s.date) ?? { mvCad: 0, isPartial: false };
      cur.mvCad += Number(s.marketValueCad);
      if (s.isPartial) cur.isPartial = true;
      seriesByDate.set(s.date, cur);
    }
    const benchmarkSelected = computeBenchmarkStats(selectedRange.from, selectedRange.to, selectedStats.startValueCad);
    const benchmarkByDate = new Map(benchmarkSelected.series.map((s) => [s.date, s.valueCad]));
    const series = [...seriesByDate.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, v]) => ({
        date,
        portfolioValueCad: v.mvCad,
        benchmarkValueCad: benchmarkByDate.get(date) ?? 0,
        isPartial: v.isPartial,
      }));

    const accountIds = [...new Set(allSnapshots
      .filter((s) => s.date >= selectedRange.from && s.date <= selectedRange.to)
      .map((s) => s.accountId))];
    const accountMap = new Map(
      (await Account.findAll({ where: { id: { [Op.in]: accountIds } } })).map((a) => [a.id, a]),
    );
    const totalEnd = selectedStats.endValueCad || 1;
    const byAccount = accountIds.map((accountId) => {
      const inRange = allSnapshots.filter((s) => s.accountId === accountId && s.date >= selectedRange.from && s.date <= selectedRange.to);
      const points: DailyPoint[] = inRange.map((s) => ({
        date: s.date,
        marketValueCad: Number(s.marketValueCad),
        cashFlowCad: Number(s.cashFlowCad),
      }));
      const twrPct = computeTwr(points);
      const endValueCad = points[points.length - 1]?.marketValueCad ?? 0;
      return {
        accountId,
        accountName: accountMap.get(accountId)?.name ?? '',
        twrPct,
        endValueCad,
        weightInPortfolioPct: (endValueCad / totalEnd) * 100,
      };
    });

    const partialSnaps = allSnapshots.filter((s) => s.date >= selectedRange.from && s.date <= selectedRange.to && s.isPartial);
    const partialDaysCount = new Set(partialSnaps.map((s) => s.date)).size;
    const reasonSet = new Set<string>();
    for (const s of partialSnaps) {
      for (const r of s.missingDataReasons ?? []) {
        if (reasonSet.size >= 20) break;
        reasonSet.add(r);
      }
      if (reasonSet.size >= 20) break;
    }
    const caveats = {
      partialDaysCount,
      missingDataReasons: [...reasonSet].slice(0, 20),
      benchmarkSymbol,
      benchmarkIsPartial,
    };

    const response: PortfolioPerformance = {
      range,
      stats: selectedStats,
      presetStats,
      series,
      byAccount,
      caveats,
    };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

export default router;
