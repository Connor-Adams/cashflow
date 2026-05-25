/**
 * Lazy + user-triggered backfill orchestration. Each ensureX function:
 *   1. checks current freshness in the DB
 *   2. if stale/never, enqueues a single in-flight promise (dedupe)
 *   3. returns the current BackfillStatus immediately so callers don't block
 *
 * The in-flight registry keys on `${endpoint}:${securityId}` so concurrent
 * price + dividend + overview requests for the same security do not collide.
 *
 * Rate budget is in-process and resets at UTC midnight (see RateBudget).
 * Single-server assumption — multi-process deploys would over-spend.
 */
import { Security, SecurityDailyPrice, SecurityDividend } from '../models';
import { RateBudget } from './rateBudget';
import * as defaultAv from './avClient';

export type BackfillStatus = {
  status: 'fresh' | 'stale' | 'never' | 'in_progress' | 'rate_limited';
  lastFetchedAt: string | null;
  nextRetryAt: string | null;
  coverageDays: number;
};

type AvClient = Pick<typeof defaultAv, 'fetchDailyAdjusted' | 'fetchDividends' | 'fetchOverview'>;

let av: AvClient = defaultAv;
let rateBudget = new RateBudget({ dailyCap: 20 });
const inFlight = new Map<string, Promise<void>>();

const OVERVIEW_STALE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

/** Test seam — replaces the AV client with a stub. */
export function __setAvClient(stub: AvClient): void {
  av = stub;
}
/** Test seam — resets in-flight map + rate budget. */
export function __resetForTests(): void {
  inFlight.clear();
  rateBudget = new RateBudget({ dailyCap: 20 });
  av = defaultAv;
}
/** Test seam — drains all rate budget so the next spend() fails. */
export function __exhaustRateBudget(): void {
  while (rateBudget.spend()) { /* keep spending */ }
}

function yesterdayISODate(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function enqueue(key: string, work: () => Promise<void>): void {
  if (inFlight.has(key)) return;
  const p = work()
    .catch((err) => {
      console.warn(`[backfill] ${key} failed: ${err instanceof Error ? err.message : err}`);
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, p);
}

function makeRateLimited(): BackfillStatus {
  return {
    status: 'rate_limited',
    lastFetchedAt: null,
    nextRetryAt: rateBudget.nextResetAt().toISOString(),
    coverageDays: 0,
  };
}

export async function ensureDailyPrices(securityId: number): Promise<BackfillStatus> {
  const key = `prices:${securityId}`;
  const sec = await Security.findByPk(securityId);
  if (!sec) {
    return { status: 'fresh', lastFetchedAt: null, nextRetryAt: null, coverageDays: 0 };
  }
  const rowCount = await SecurityDailyPrice.count({ where: { securityId } });
  const latest = await SecurityDailyPrice.findOne({
    where: { securityId },
    order: [['date', 'DESC']],
  });
  const lastFetchedAt = latest?.fetchedAt?.toISOString() ?? null;

  if (inFlight.has(key)) {
    return {
      status: 'in_progress',
      lastFetchedAt,
      nextRetryAt: null,
      coverageDays: rowCount,
    };
  }

  if (rowCount === 0) {
    if (!rateBudget.spend()) return makeRateLimited();
    enqueue(key, () => backfillDailyFull(sec.id, sec.symbol));
    return { status: 'never', lastFetchedAt, nextRetryAt: null, coverageDays: 0 };
  }
  if (latest && latest.date < yesterdayISODate()) {
    if (!rateBudget.spend()) return makeRateLimited();
    enqueue(key, () => backfillDailyCompact(sec.id, sec.symbol));
    return { status: 'stale', lastFetchedAt, nextRetryAt: null, coverageDays: rowCount };
  }
  return { status: 'fresh', lastFetchedAt, nextRetryAt: null, coverageDays: rowCount };
}

async function backfillDailyFull(securityId: number, symbol: string): Promise<void> {
  const bars = await av.fetchDailyAdjusted(symbol, 'full');
  if (!bars || bars.length === 0) return;
  await upsertBars(securityId, bars);
}

async function backfillDailyCompact(securityId: number, symbol: string): Promise<void> {
  const bars = await av.fetchDailyAdjusted(symbol, 'compact');
  if (!bars || bars.length === 0) return;
  await upsertBars(securityId, bars);
}

async function upsertBars(securityId: number, bars: Awaited<ReturnType<typeof av.fetchDailyAdjusted>>): Promise<void> {
  if (!bars) return;
  const now = new Date();
  for (const bar of bars) {
    await SecurityDailyPrice.upsert({
      securityId,
      date: bar.date,
      open: bar.open != null ? String(bar.open) : null,
      high: bar.high != null ? String(bar.high) : null,
      low: bar.low != null ? String(bar.low) : null,
      close: String(bar.close),
      adjClose: String(bar.adjClose),
      volume: bar.volume,
      source: 'alpha_vantage',
      fetchedAt: now,
    });
  }
}

export async function ensureDividends(securityId: number): Promise<BackfillStatus> {
  const key = `dividends:${securityId}`;
  const sec = await Security.findByPk(securityId);
  if (!sec) {
    return { status: 'fresh', lastFetchedAt: null, nextRetryAt: null, coverageDays: 0 };
  }
  const rowCount = await SecurityDividend.count({ where: { securityId } });
  const latest = await SecurityDividend.findOne({
    where: { securityId },
    order: [['exDividendDate', 'DESC']],
  });
  const lastFetchedAt = latest?.fetchedAt?.toISOString() ?? null;

  if (inFlight.has(key)) {
    return {
      status: 'in_progress',
      lastFetchedAt,
      nextRetryAt: null,
      coverageDays: rowCount,
    };
  }
  // Refresh dividends if never fetched OR latest fetchedAt > 30 days old.
  const staleAgeMs = 30 * 24 * 60 * 60 * 1000;
  const isStale =
    latest != null &&
    Date.now() - latest.fetchedAt.getTime() > staleAgeMs;

  if (rowCount === 0 || isStale) {
    if (!rateBudget.spend()) return makeRateLimited();
    enqueue(key, async () => {
      const events = await av.fetchDividends(sec.symbol);
      if (!events) return;
      const now = new Date();
      for (const ev of events) {
        await SecurityDividend.upsert({
          securityId,
          exDividendDate: ev.exDividendDate,
          declarationDate: ev.declarationDate,
          recordDate: ev.recordDate,
          paymentDate: ev.paymentDate,
          amount: String(ev.amount),
          currency: ev.currency,
          source: 'alpha_vantage',
          fetchedAt: now,
        });
      }
    });
    return { status: rowCount === 0 ? 'never' : 'stale', lastFetchedAt, nextRetryAt: null, coverageDays: rowCount };
  }
  return { status: 'fresh', lastFetchedAt, nextRetryAt: null, coverageDays: rowCount };
}

export async function ensureOverview(securityId: number): Promise<BackfillStatus> {
  const key = `overview:${securityId}`;
  const sec = await Security.findByPk(securityId);
  if (!sec) {
    return { status: 'fresh', lastFetchedAt: null, nextRetryAt: null, coverageDays: 0 };
  }
  const fetched = sec.metadataFetchedAt;
  const lastFetchedAt = fetched?.toISOString() ?? null;
  const isStale = fetched != null && Date.now() - fetched.getTime() > OVERVIEW_STALE_MS;
  const isNever = sec.metadata == null;

  if (inFlight.has(key)) {
    return { status: 'in_progress', lastFetchedAt, nextRetryAt: null, coverageDays: isNever ? 0 : 1 };
  }
  if (isNever || isStale) {
    if (!rateBudget.spend()) return makeRateLimited();
    enqueue(key, async () => {
      const overview = await av.fetchOverview(sec.symbol);
      if (!overview) return;
      await sec.update({
        metadata: {
          sector: overview.sector,
          industry: overview.industry,
          country: overview.country,
          exchange: overview.exchange,
          description: overview.description,
          ...overview.raw,
        },
        metadataFetchedAt: new Date(),
      });
    });
    return {
      status: isNever ? 'never' : 'stale',
      lastFetchedAt,
      nextRetryAt: null,
      coverageDays: isNever ? 0 : 1,
    };
  }
  return { status: 'fresh', lastFetchedAt, nextRetryAt: null, coverageDays: 1 };
}
