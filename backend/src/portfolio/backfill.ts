/**
 * Lazy + user-triggered Alpha Vantage backfill orchestration.
 *
 * Each `ensureX` function:
 *   1. Checks current freshness in the DB.
 *   2. If stale or never fetched, enqueues a single in-flight promise so
 *      concurrent callers for the same (endpoint, security) do not collide.
 *   3. Returns the current `BackfillStatus` immediately so callers do not
 *      block on the network round-trip.
 *
 * The shared Alpha Vantage daily call budget lives in the `provider_job_log`
 * table (see `../integrations/alphaVantage/budget`). Both the background
 * scheduler and these lazy ensure-* paths consult the same counter, so the
 * total number of AV calls per UTC day stays under the free-tier ceiling
 * regardless of which subsystem triggered the work.
 *
 * Trade-off: budget checks are optimistic — a burst of concurrent calls can
 * race past the cap before any of them have written their `ok` row. In
 * practice the per-(endpoint, security) in-flight dedupe and the 4-minute
 * scheduler cadence keep the overshoot bounded to a handful of calls per
 * day, which is comfortably inside the 3-call headroom the 22/25 default
 * budget leaves.
 */
import { Security, SecurityDailyPrice, SecurityDividend } from '../models';
import * as defaultAv from '../integrations/alphaVantage/client';
import {
  ALPHA_VANTAGE_PROVIDER,
  checkBudget,
  recordCall,
} from '../integrations/alphaVantage/budget';
import { AlphaVantageError } from '../integrations/alphaVantage/client';
import * as env from '../config/env';
import { logger } from '../observability/logger';

export type BackfillStatus = {
  status: 'fresh' | 'stale' | 'never' | 'in_progress' | 'rate_limited';
  lastFetchedAt: string | null;
  nextRetryAt: string | null;
  coverageDays: number;
};

type AvClient = Pick<
  typeof defaultAv,
  'fetchDailyAdjusted' | 'fetchDividends' | 'fetchOverview' | 'fetchGlobalQuote'
>;

let av: AvClient = defaultAv;
let budgetCapOverride: number | null = null;
const inFlight = new Map<string, Promise<void>>();

const OVERVIEW_STALE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const DIVIDENDS_STALE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Test seam — replaces the AV client with a stub. */
export function __setAvClient(stub: AvClient): void {
  av = stub;
}
/** Test seam — overrides the daily budget cap so tests don't need to seed 22 rows. */
export function __setBudgetCap(cap: number | null): void {
  budgetCapOverride = cap;
}
/** Test seam — clears in-flight map + restores default client + clears cap override. */
export function __resetForTests(): void {
  inFlight.clear();
  av = defaultAv;
  budgetCapOverride = null;
}

function activeBudgetCap(): number {
  return budgetCapOverride ?? env.quoteDailyBudget;
}

function yesterdayISODate(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function nextUtcMidnight(now: Date = new Date()): Date {
  return new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
      0,
      0,
      0,
      0,
    ),
  );
}

function enqueue(key: string, work: () => Promise<void>): void {
  if (inFlight.has(key)) return;
  const p = work()
    .catch((err) => {
      logger.warn('backfill_failed', {
        key,
        provider: ALPHA_VANTAGE_PROVIDER,
        error: err instanceof Error ? err.message : String(err),
      });
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
    nextRetryAt: nextUtcMidnight().toISOString(),
    coverageDays: 0,
  };
}

/**
 * Wraps an AV fetch + DB upsert in unified budget accounting:
 *   - Records `ok` on a successful fetch that returned usable data.
 *   - Records `not_found` when AV returned no data for the symbol.
 *   - Records `rate_limited` or `error` based on `AlphaVantageError` shape.
 *
 * The fetch itself is not guarded by `checkBudget` here — callers must do
 * that synchronously before `enqueue()` to keep the budget pre-check tight
 * around the work item that consumes the slot.
 */
async function runTrackedFetch<T>(
  fnName: 'TIME_SERIES_DAILY_ADJUSTED' | 'DIVIDENDS' | 'OVERVIEW' | 'GLOBAL_QUOTE',
  symbol: string,
  fetcher: () => Promise<T | null>,
  persist: (result: T) => Promise<void>,
): Promise<void> {
  try {
    const result = await fetcher();
    if (result == null) {
      await recordCall({ function: fnName, symbol, status: 'not_found' });
      return;
    }
    await persist(result);
    await recordCall({ function: fnName, symbol, status: 'ok' });
  } catch (err) {
    if (err instanceof AlphaVantageError) {
      const isRateLimit = err.providerNote != null;
      await recordCall({
        function: fnName,
        symbol,
        status: isRateLimit ? 'rate_limited' : 'error',
        httpStatus: err.httpStatus,
        errorMessage: err.message.slice(0, 1024),
      });
    } else {
      const message = err instanceof Error ? err.message : String(err);
      await recordCall({
        function: fnName,
        symbol,
        status: 'error',
        errorMessage: message.slice(0, 1024),
      });
    }
    throw err;
  }
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
    const budget = await checkBudget(activeBudgetCap());
    if (!budget.ok) return makeRateLimited();
    enqueue(key, () => backfillDaily(sec.id, sec.symbol, 'full'));
    return { status: 'never', lastFetchedAt, nextRetryAt: null, coverageDays: 0 };
  }
  if (latest && latest.date < yesterdayISODate()) {
    const budget = await checkBudget(activeBudgetCap());
    if (!budget.ok) return makeRateLimited();
    enqueue(key, () => backfillDaily(sec.id, sec.symbol, 'compact'));
    return { status: 'stale', lastFetchedAt, nextRetryAt: null, coverageDays: rowCount };
  }
  return { status: 'fresh', lastFetchedAt, nextRetryAt: null, coverageDays: rowCount };
}

async function backfillDaily(
  securityId: number,
  symbol: string,
  outputsize: 'compact' | 'full',
): Promise<void> {
  await runTrackedFetch(
    'TIME_SERIES_DAILY_ADJUSTED',
    symbol,
    () => av.fetchDailyAdjusted(symbol, outputsize),
    async (bars) => {
      if (bars.length === 0) return;
      await upsertBars(securityId, bars);
    },
  );
}

async function upsertBars(
  securityId: number,
  bars: Awaited<ReturnType<typeof av.fetchDailyAdjusted>>,
): Promise<void> {
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
      source: ALPHA_VANTAGE_PROVIDER,
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

  const isStale =
    latest != null && Date.now() - latest.fetchedAt.getTime() > DIVIDENDS_STALE_MS;

  if (rowCount === 0 || isStale) {
    const budget = await checkBudget(activeBudgetCap());
    if (!budget.ok) return makeRateLimited();
    enqueue(key, () =>
      runTrackedFetch(
        'DIVIDENDS',
        sec.symbol,
        () => av.fetchDividends(sec.symbol),
        async (events) => {
          if (events.length === 0) return;
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
              source: ALPHA_VANTAGE_PROVIDER,
              fetchedAt: now,
            });
          }
        },
      ),
    );
    return {
      status: rowCount === 0 ? 'never' : 'stale',
      lastFetchedAt,
      nextRetryAt: null,
      coverageDays: rowCount,
    };
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
    const budget = await checkBudget(activeBudgetCap());
    if (!budget.ok) return makeRateLimited();
    enqueue(key, () =>
      runTrackedFetch(
        'OVERVIEW',
        sec.symbol,
        () => av.fetchOverview(sec.symbol),
        async (overview) => {
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
        },
      ),
    );
    return {
      status: isNever ? 'never' : 'stale',
      lastFetchedAt,
      nextRetryAt: null,
      coverageDays: isNever ? 0 : 1,
    };
  }
  return { status: 'fresh', lastFetchedAt, nextRetryAt: null, coverageDays: 1 };
}
