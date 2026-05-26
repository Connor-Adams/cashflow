/**
 * Lazy + user-triggered Yahoo Finance backfill orchestration.
 *
 * Each `ensureX` function:
 *   1. Checks current freshness in the DB.
 *   2. If stale or never fetched, enqueues a single in-flight promise so
 *      concurrent callers for the same (endpoint, security) do not collide.
 *   3. Returns the current `BackfillStatus` immediately so callers do not
 *      block on the network round-trip.
 *
 * Yahoo's public API has no documented per-key quota, so unlike the
 * previous Alpha Vantage implementation we do not gate work on a daily
 * budget counter. Every call is still recorded in `provider_job_log` for
 * diagnostics, retry/stale logic, and rate-limit detection.
 */
import { Security, SecurityDailyPrice, SecurityDividend } from '../models';
import * as defaultYahoo from '../integrations/yahoo/client';
import { YahooFinanceError } from '../integrations/yahoo/client';
import { recordCall } from '../integrations/yahoo/jobLog';
import { overviewToMetadata } from '../integrations/yahoo/overviewMetadata';
import { enumerateYahooSymbols } from '../integrations/yahoo/symbol';
import * as env from '../config/env';
import { logger } from '../observability/logger';
import { reconcileDividendsForSecurity } from './reconcileDividends';

function symbolCandidates(sec: Security): string[] {
  return enumerateYahooSymbols(sec.symbol, {
    currency: sec.currency,
    assetType: sec.assetType,
    name: sec.name,
  });
}

export type BackfillStatus = {
  status: 'fresh' | 'stale' | 'never' | 'in_progress' | 'rate_limited';
  lastFetchedAt: string | null;
  nextRetryAt: string | null;
  coverageDays: number;
};

type YahooFetchers = Pick<
  typeof defaultYahoo,
  'fetchDailyHistory' | 'fetchDividends' | 'fetchOverview' | 'fetchQuote'
>;

let yahoo: YahooFetchers = defaultYahoo;
const inFlight = new Map<string, Promise<void>>();

const OVERVIEW_STALE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const DIVIDENDS_STALE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const DAILY_HISTORY_PERIOD1_MS = 5 * 365 * 24 * 60 * 60 * 1000; // 5 years

/** Test seam — replaces the Yahoo client with a stub. */
export function __setYahooFetchers(stub: YahooFetchers): void {
  yahoo = stub;
}
/** Test seam — clears in-flight map + restores default client. */
export function __resetForTests(): void {
  inFlight.clear();
  yahoo = defaultYahoo;
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
      logger.warn({
        key,
        provider: defaultYahoo.YAHOO_PROVIDER,
        error: err instanceof Error ? err.message : String(err),
      }, 'backfill_failed');
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, p);
}

type YahooFnName = 'DAILY_HISTORY' | 'DIVIDENDS' | 'OVERVIEW' | 'QUOTE';

/**
 * Walks a candidate symbol list and stops on the first one that returns
 * usable data. Each attempt is logged to `provider_job_log` so the
 * staleness picker can see what was tried. Errors surface from the first
 * failing attempt and abort the chain — we only retry on `null` (the
 * "Yahoo returned successfully but had no data" path), not on transport
 * or rate-limit failures.
 */
async function runTrackedFetch<T>(
  fnName: YahooFnName,
  candidates: string[],
  fetcher: (symbol: string) => Promise<T | null>,
  persist: (symbol: string, result: T) => Promise<void>,
): Promise<void> {
  if (candidates.length === 0) return;
  for (let i = 0; i < candidates.length; i++) {
    const symbol = candidates[i];
    const isLast = i === candidates.length - 1;
    try {
      const result = await fetcher(symbol);
      if (result == null) {
        await recordCall({ function: fnName, symbol, status: 'not_found' });
        if (isLast) return;
        continue;
      }
      await persist(symbol, result);
      await recordCall({ function: fnName, symbol, status: 'ok' });
      return;
    } catch (err) {
      if (err instanceof YahooFinanceError) {
        const isRateLimit =
          err.httpStatus === 429 || /rate.?limit/i.test(err.message);
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

  if (symbolCandidates(sec).length === 0) {
    return { status: 'fresh', lastFetchedAt, nextRetryAt: null, coverageDays: rowCount };
  }
  if (rowCount === 0) {
    enqueue(key, () => backfillDaily(sec, 'full'));
    return { status: 'never', lastFetchedAt, nextRetryAt: null, coverageDays: 0 };
  }
  if (latest && latest.date < yesterdayISODate()) {
    enqueue(key, () => backfillDaily(sec, 'compact'));
    return { status: 'stale', lastFetchedAt, nextRetryAt: null, coverageDays: rowCount };
  }
  return { status: 'fresh', lastFetchedAt, nextRetryAt: null, coverageDays: rowCount };
}

async function backfillDaily(
  sec: Security,
  outputsize: 'compact' | 'full',
): Promise<void> {
  const candidates = symbolCandidates(sec);
  if (candidates.length === 0) return;
  const period1 =
    outputsize === 'full'
      ? new Date(Date.now() - DAILY_HISTORY_PERIOD1_MS)
      : new Date(Date.now() - 120 * 86400000);
  await runTrackedFetch(
    'DAILY_HISTORY',
    candidates,
    (symbol) => yahoo.fetchDailyHistory(symbol, { period1 }),
    async (_symbol, bars) => {
      if (bars.length === 0) return;
      await upsertBars(sec.id, bars);
    },
  );
}

async function upsertBars(
  securityId: number,
  bars: Awaited<ReturnType<typeof yahoo.fetchDailyHistory>>,
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
      source: defaultYahoo.YAHOO_PROVIDER,
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

  const candidates = symbolCandidates(sec);
  if (candidates.length === 0) {
    return { status: 'fresh', lastFetchedAt, nextRetryAt: null, coverageDays: rowCount };
  }

  if (rowCount === 0 || isStale) {
    enqueue(key, async () => {
      await runTrackedFetch(
        'DIVIDENDS',
        candidates,
        (symbol) => yahoo.fetchDividends(symbol),
        async (_symbol, events) => {
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
              source: defaultYahoo.YAHOO_PROVIDER,
              fetchedAt: now,
            });
          }
        },
      );
      if (env.dividendReconcileEnabled) {
        await reconcileDividendsForSecurity(securityId);
      }
    });
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
  const ageStale = fetched != null && Date.now() - fetched.getTime() > OVERVIEW_STALE_MS;
  // Schema-stale: rows persisted before a metadata-shape rollout lack the
  // newest structured keys. Force a refresh so users see new fields on the
  // first visit instead of waiting out the 90-day staleness window.
  //
  // Canary keys (bump these whenever fetchOverview adds new fields):
  //   - marketCap                  (rollout 1: market data / fundamentals / analysts)
  //   - fundExpenseRatio           (rollout 2: fund + crypto fields)
  //   - nextEarningsDate           (rollout 3: earnings + analyst trend modules)
  const SCHEMA_CANARIES = ['marketCap', 'fundExpenseRatio', 'nextEarningsDate'] as const;
  const metadataKeys = sec.metadata as Record<string, unknown> | null;
  const schemaStale =
    metadataKeys != null && SCHEMA_CANARIES.some((k) => !(k in metadataKeys));
  const isStale = ageStale || schemaStale;
  const isNever = sec.metadata == null;

  if (inFlight.has(key)) {
    return { status: 'in_progress', lastFetchedAt, nextRetryAt: null, coverageDays: isNever ? 0 : 1 };
  }
  const candidates = symbolCandidates(sec);
  if (candidates.length === 0) {
    return { status: 'fresh', lastFetchedAt, nextRetryAt: null, coverageDays: isNever ? 0 : 1 };
  }
  if (isNever || isStale) {
    enqueue(key, () =>
      runTrackedFetch(
        'OVERVIEW',
        candidates,
        (symbol) => yahoo.fetchOverview(symbol),
        async (_symbol, overview) => {
          await sec.update({
            metadata: overviewToMetadata(overview),
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
