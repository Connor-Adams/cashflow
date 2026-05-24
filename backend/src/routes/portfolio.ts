import { Router, type Request } from 'express';
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
import { computeAcb, type AcbActivity, type AcbResult } from '../portfolio/acb';

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
    const rows = [...map.values()].map((row) => ({
      ...row,
      unrealizedGainLoss:
        row.totalCostBasis != null ? row.totalMarketValue - row.totalCostBasis : null,
    }));
    rows.sort((a, b) => b.totalMarketValue - a.totalMarketValue);
    res.json({ rows });
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
      activityType: ['buy', 'sell'],
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
    }));
    const acb = computeAcb(acbInput);
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
      }));
      const acb = computeAcb(acbInput);

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
