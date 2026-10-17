/**
 * Pick the next (security, function) work item for the scheduler.
 *
 * Strategy: across every distinct held Security row (keyed on id so each
 * row's currency-aware Yahoo symbol can be resolved at fetch time) and
 * every function the scheduler is willing to refresh, compute each pair's
 * staleness ratio (`age / target`), where age runs from the last attempt
 * of any outcome across every candidate suffix. Pairs that have never been
 * attempted score `+Infinity`. The eligible pair with the highest ratio wins.
 *
 * Each function declares its own target age — QUOTE is refreshed every
 * ~day, OVERVIEW every ~quarter, DIVIDENDS every month. QUOTE additionally
 * honors a min-age floor that prevents same-symbol refresh storms inside
 * a single tick window.
 */
import { Op, fn, col } from 'sequelize';
import { Security } from '../../models/Security';
import { ProviderJobLog } from '../../models/ProviderJobLog';
import { YAHOO_PROVIDER } from './client';
import { enumerateYahooSymbols } from './symbol';

export type YahooWorkFunction = 'QUOTE' | 'OVERVIEW' | 'DIVIDENDS';

export interface WorkItem {
  function: YahooWorkFunction;
  securityId: number;
  storedSymbol: string;
  yahooSymbol: string;
  lastFetchedAt: Date | null;
  ageSeconds: number;
  stalenessRatio: number;
}

export interface PickerOptions {
  minAgeSeconds: number;
  now?: Date;
  functions?: YahooWorkFunction[];
  targetAgeSeconds?: Partial<Record<YahooWorkFunction, number>>;
}

const DAY_SECONDS = 24 * 3600;
const DEFAULT_TARGET_AGE_SECONDS: Record<YahooWorkFunction, number> = {
  QUOTE: 1 * DAY_SECONDS,
  DIVIDENDS: 30 * DAY_SECONDS,
  OVERVIEW: 90 * DAY_SECONDS,
};
const DEFAULT_FUNCTIONS: YahooWorkFunction[] = ['QUOTE', 'DIVIDENDS', 'OVERVIEW'];

async function eligibleSecurities(): Promise<
  Array<{
    id: number;
    symbol: string;
    currency: string;
    assetType: string | null;
    name: string | null;
  }>
> {
  const rows = await Security.findAll({
    where: { symbol: { [Op.ne]: '' } },
    attributes: ['id', 'symbol', 'currency', 'assetType', 'name'],
    order: [['id', 'ASC']],
  });
  return rows.map((r) => ({
    id: r.id,
    symbol: r.symbol,
    currency: r.currency,
    assetType: r.assetType,
    name: r.name,
  }));
}

interface PairHistory {
  /** Most recent `ok` row — when data was last actually refreshed. */
  lastOk: Date | null;
  /** Most recent row of any status — when we last tried. */
  lastAttempt: Date | null;
}

const later = (a: Date | null, b: Date | null): Date | null =>
  a == null ? b : b == null || a >= b ? a : b;

/**
 * Latest fetch timestamps per (function, yahooSymbol), split by outcome.
 * Keyed on every candidate symbol, not just the primary: the scheduler logs
 * each suffix it tries (`X.TO`, `X.V`, `X.CN`) under that suffix.
 */
async function fetchHistoryByPair(
  yahooSymbols: string[],
  functions: YahooWorkFunction[],
): Promise<Map<YahooWorkFunction, Map<string, PairHistory>>> {
  const out = new Map<YahooWorkFunction, Map<string, PairHistory>>();
  for (const fnName of functions) out.set(fnName, new Map());
  if (yahooSymbols.length === 0 || functions.length === 0) return out;

  const rows = await ProviderJobLog.findAll({
    attributes: ['function', 'symbol', 'status', [fn('MAX', col('fetched_at')), 'lastFetchedAt']],
    where: {
      provider: YAHOO_PROVIDER,
      function: { [Op.in]: functions },
      symbol: { [Op.in]: yahooSymbols },
    },
    group: ['function', 'symbol', 'status'],
    raw: true,
  });
  for (const row of rows) {
    const r = row as unknown as {
      function: YahooWorkFunction | null;
      symbol: string | null;
      status: string | null;
      lastFetchedAt: Date | string | null;
    };
    if (!r.function || !r.symbol || !r.lastFetchedAt) continue;
    const ts = r.lastFetchedAt instanceof Date ? r.lastFetchedAt : new Date(r.lastFetchedAt);
    if (!Number.isFinite(ts.getTime())) continue;
    const inner = out.get(r.function);
    if (!inner) continue;
    const prev = inner.get(r.symbol) ?? { lastOk: null, lastAttempt: null };
    inner.set(r.symbol, {
      lastOk: r.status === 'ok' ? later(prev.lastOk, ts) : prev.lastOk,
      lastAttempt: later(prev.lastAttempt, ts),
    });
  }
  return out;
}

export async function pickNext(opts: PickerOptions): Promise<WorkItem | null> {
  const now = opts.now ?? new Date();
  const functions = opts.functions ?? DEFAULT_FUNCTIONS;
  const targets: Record<YahooWorkFunction, number> = {
    ...DEFAULT_TARGET_AGE_SECONDS,
    ...opts.targetAgeSeconds,
  };

  const securities = await eligibleSecurities();
  if (securities.length === 0) return null;
  const candidatesFor = (s: (typeof securities)[number]) =>
    enumerateYahooSymbols(s.symbol, {
      currency: s.currency,
      assetType: s.assetType,
      name: s.name,
    });
  const resolvable = securities
    .map((s) => ({ ...s, candidates: candidatesFor(s) }))
    .filter((s) => s.candidates.length > 0);
  if (resolvable.length === 0) return null;
  const allSymbols = Array.from(new Set(resolvable.flatMap((s) => s.candidates)));
  const history = await fetchHistoryByPair(allSymbols, functions);

  let best: WorkItem | null = null;
  for (const s of resolvable) {
    const yahooSymbol = s.candidates[0];
    for (const fnName of functions) {
      const bySymbol = history.get(fnName);
      let lastOk: Date | null = null;
      let lastAttempt: Date | null = null;
      for (const candidate of s.candidates) {
        const h = bySymbol?.get(candidate);
        if (!h) continue;
        lastOk = later(lastOk, h.lastOk);
        lastAttempt = later(lastAttempt, h.lastAttempt);
      }
      // Staleness runs off the last *attempt*, not the last success: a
      // not_found / error waits out the same target age before its retry.
      // Scoring failures as never-fetched (+Infinity) let one unresolvable
      // symbol win every tick and starve the rest of the queue.
      const ageSeconds = lastAttempt
        ? Math.max(0, (now.getTime() - lastAttempt.getTime()) / 1000)
        : Number.POSITIVE_INFINITY;

      if (fnName === 'QUOTE' && ageSeconds < opts.minAgeSeconds) continue;

      const target = targets[fnName];
      const stalenessRatio = target > 0 ? ageSeconds / target : Number.POSITIVE_INFINITY;
      if (stalenessRatio < 1) continue;

      if (!best || stalenessRatio > best.stalenessRatio) {
        best = {
          function: fnName,
          securityId: s.id,
          storedSymbol: s.symbol,
          yahooSymbol,
          lastFetchedAt: lastOk,
          ageSeconds,
          stalenessRatio,
        };
      }
    }
  }
  return best;
}
