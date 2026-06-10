/**
 * Portfolio per-row metrics: pure compute helpers + a batch context loader.
 *
 * Both /api/portfolio (Holdings) and /api/portfolio/by-security routes call
 * loadMetricsContext once per request to pre-fetch every security's daily
 * prices, dividends, FX rates, realized totals, and lifetime income, then
 * call the four pure compute helpers per row.
 */
import { Op } from 'sequelize';
import {
  InvestmentActivity,
  SecurityDailyPrice,
  SecurityDividend,
  SecurityPrice,
} from '../models';
import { ensureFxRate } from '../fx/bankOfCanada';

export type DailyRow = { close: number; adjClose: number; date: string };

export type MetricsContext = {
  latestDaily: Map<number, DailyRow>
  prevDaily: Map<number, DailyRow>
  /**
   * Unadjusted close ~30 days ago. The 30-day return adds the window's
   * dividends explicitly (divPerUnit30d), so the base must be the raw close —
   * adjClose is already deflated by those dividends and would double-count.
   */
  daily30dAgo: Map<number, { close: number }>
  latestQuotes: Map<number, { price: number; currency: string }>
  divPerUnit30d: Map<number, number>
  divPerUnit365d: Map<number, number>
  fxRates: Map<string, number>
  realizedBySec: Map<number, number>
  dividendsBySec: Map<number, number>
  interestBySec: Map<number, number>
};

export type RowMetrics = {
  todayChangePct: number | null
  thirtyDayReturnPct: number | null
  yieldOnCostPct: number | null
};

export function computeRowMetrics(args: {
  ctx: MetricsContext
  securityId: number
  qty: number
  costBasis: number | null
}): RowMetrics {
  const { ctx, securityId, qty, costBasis } = args;
  const quote = ctx.latestQuotes.get(securityId);
  const prev = ctx.prevDaily.get(securityId);
  const today30 = ctx.daily30dAgo.get(securityId);
  const latestForReturn = quote?.price ?? ctx.latestDaily.get(securityId)?.adjClose ?? null;
  const div30 = ctx.divPerUnit30d.get(securityId) ?? 0;
  const div365 = ctx.divPerUnit365d.get(securityId) ?? 0;

  const todayChangePct =
    quote != null && prev != null && prev.adjClose !== 0
      ? ((quote.price - prev.adjClose) / prev.adjClose) * 100
      : null;

  const thirtyDayReturnPct =
    latestForReturn != null && today30 != null && today30.close !== 0
      ? ((latestForReturn + div30 - today30.close) / today30.close) * 100
      : null;

  const yieldOnCostPct =
    costBasis != null && costBasis !== 0 && qty > 0 && div365 > 0
      ? ((div365 * qty) / costBasis) * 100
      : null;

  return { todayChangePct, thirtyDayReturnPct, yieldOnCostPct };
}

export function computeWeightPct(args: {
  ctx: MetricsContext
  cadMarketValue: number
  unifiedTotalCad: number | null
}): number | null {
  const { cadMarketValue, unifiedTotalCad } = args;
  if (unifiedTotalCad == null || unifiedTotalCad === 0) return null;
  return (cadMarketValue / unifiedTotalCad) * 100;
}

export function computeTotalReturnPct(args: {
  ctx: MetricsContext
  securityId: number
  currentMV: number
  costBasis: number | null
}): number | null {
  const { ctx, securityId, currentMV, costBasis } = args;
  if (costBasis == null || costBasis === 0) return null;
  const realized = ctx.realizedBySec.get(securityId) ?? 0;
  const income = (ctx.dividendsBySec.get(securityId) ?? 0) + (ctx.interestBySec.get(securityId) ?? 0);
  return ((currentMV + realized + income - costBasis) / costBasis) * 100;
}

export function computeUnifiedTodayDelta(args: {
  ctx: MetricsContext
  holdings: Array<{ securityId: number; quantity: number; currency: string }>
}): { todayChangePct: number | null; todayChangeCad: number | null } {
  const { ctx, holdings } = args;
  let sumToday = 0;
  let sumPrev = 0;
  let any = false;
  for (const h of holdings) {
    const quote = ctx.latestQuotes.get(h.securityId);
    const prev = ctx.prevDaily.get(h.securityId);
    if (!quote || !prev) continue;
    const fxRate =
      h.currency === 'CAD' ? 1 : ctx.fxRates.get(h.currency);
    if (fxRate == null) continue;
    sumToday += quote.price * h.quantity * fxRate;
    sumPrev += prev.adjClose * h.quantity * fxRate;
    any = true;
  }
  if (!any || sumPrev === 0) {
    return { todayChangePct: null, todayChangeCad: null };
  }
  const delta = sumToday - sumPrev;
  return {
    todayChangePct: (delta / sumPrev) * 100,
    todayChangeCad: delta,
  };
}

const DAY_MS = 86400000;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function loadMetricsContext(args: {
  securityIds: number[]
  currencies: string[]
  accountIds: number[]
  asOfDate?: string
}): Promise<MetricsContext> {
  const ctx: MetricsContext = {
    latestDaily: new Map(),
    prevDaily: new Map(),
    daily30dAgo: new Map(),
    latestQuotes: new Map(),
    divPerUnit30d: new Map(),
    divPerUnit365d: new Map(),
    fxRates: new Map(),
    realizedBySec: new Map(),
    dividendsBySec: new Map(),
    interestBySec: new Map(),
  };
  if (args.securityIds.length === 0) return ctx;

  const today = isoDate(new Date());
  const asOfDate = args.asOfDate ?? today;
  const cutoff30 = isoDate(new Date(Date.now() - 30 * DAY_MS));
  const cutoff365 = isoDate(new Date(Date.now() - 365 * DAY_MS));

  // 1. Daily prices (latest + prev + ~30d ago) per security
  const dailyRows = await SecurityDailyPrice.findAll({
    where: { securityId: args.securityIds },
    order: [['securityId', 'ASC'], ['date', 'DESC']],
  });
  const seenLatest = new Set<number>();
  const seenPrev = new Set<number>();
  for (const row of dailyRows) {
    const sid = row.securityId;
    if (!seenLatest.has(sid)) {
      ctx.latestDaily.set(sid, {
        close: Number(row.close),
        adjClose: Number(row.adjClose),
        date: row.date,
      });
      seenLatest.add(sid);
      continue;
    }
    if (!seenPrev.has(sid)) {
      ctx.prevDaily.set(sid, {
        close: Number(row.close),
        adjClose: Number(row.adjClose),
        date: row.date,
      });
      seenPrev.add(sid);
    }
    // closest >=30d-old row
    if (!ctx.daily30dAgo.has(sid) && row.date <= cutoff30) {
      ctx.daily30dAgo.set(sid, { close: Number(row.close) });
    }
  }

  // 2. Latest quote (SecurityPrice) per security
  const quoteRows = await SecurityPrice.findAll({
    where: { securityId: args.securityIds },
    order: [['securityId', 'ASC'], ['pricedAt', 'DESC']],
  });
  const seenQuote = new Set<number>();
  for (const row of quoteRows) {
    if (seenQuote.has(row.securityId)) continue;
    ctx.latestQuotes.set(row.securityId, {
      price: Number(row.price),
      currency: row.currency,
    });
    seenQuote.add(row.securityId);
  }

  // 3. Dividend sums per security (30d + 365d windows, per unit)
  const dividends = await SecurityDividend.findAll({
    where: {
      securityId: args.securityIds,
      exDividendDate: { [Op.gte]: cutoff365 },
    },
  });
  for (const d of dividends) {
    const sid = d.securityId;
    const amt = Number(d.amount);
    ctx.divPerUnit365d.set(sid, (ctx.divPerUnit365d.get(sid) ?? 0) + amt);
    if (d.exDividendDate >= cutoff30) {
      ctx.divPerUnit30d.set(sid, (ctx.divPerUnit30d.get(sid) ?? 0) + amt);
    }
  }

  // 4. FX rates for non-CAD currencies
  for (const cur of args.currencies) {
    if (cur === 'CAD') continue;
    if (ctx.fxRates.has(cur)) continue;
    const fx = await ensureFxRate(cur, 'CAD', asOfDate);
    if (fx) ctx.fxRates.set(cur, fx.rate);
  }

  // 5. Per-security lifetime dividend + interest from InvestmentActivity.
  // Note: realized gain is computed by the ACB engine elsewhere; we leave
  // realizedBySec empty here. The /by-security route populates it after
  // computing ACB per security.
  if (args.accountIds.length > 0) {
    const activities = await InvestmentActivity.findAll({
      where: {
        securityId: args.securityIds,
        accountId: args.accountIds,
      },
      attributes: ['securityId', 'activityType', 'amount'],
    });
    for (const a of activities) {
      const sid = a.securityId;
      if (sid == null) continue;
      const amt = Math.abs(Number(a.amount) || 0);
      if (a.activityType === 'dividend') {
        ctx.dividendsBySec.set(sid, (ctx.dividendsBySec.get(sid) ?? 0) + amt);
      } else if (a.activityType === 'interest') {
        ctx.interestBySec.set(sid, (ctx.interestBySec.get(sid) ?? 0) + amt);
      }
    }
  }

  return ctx;
}
