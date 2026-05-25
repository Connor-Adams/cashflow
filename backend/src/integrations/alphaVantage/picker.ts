/**
 * Pick the next (symbol, function) work item for the scheduler.
 *
 * Strategy: across every distinct held symbol and every function the
 * scheduler is willing to refresh, compute each pair's staleness ratio
 * (`age / target`). Pairs that have never been fetched score `+Infinity`.
 * The eligible pair with the highest ratio wins.
 *
 * Each function declares its own target age — GLOBAL_QUOTE is refreshed
 * every ~day, OVERVIEW every ~quarter, DIVIDENDS every month. GLOBAL_QUOTE
 * additionally honors a min-age floor that prevents same-symbol refresh
 * storms within a budget day.
 *
 * Symbols are global — the same AAPL quote serves every household — so
 * the picker keys on `symbol` rather than on `Security.id`.
 */

import { Op, fn, col } from 'sequelize';
import { Security } from '../../models/Security';
import { ProviderJobLog } from '../../models/ProviderJobLog';
import { ALPHA_VANTAGE_PROVIDER } from './budget';

export type AvWorkFunction = 'GLOBAL_QUOTE' | 'OVERVIEW' | 'DIVIDENDS';

export interface WorkItem {
  function: AvWorkFunction;
  symbol: string;
  /** Last successful fetch timestamp, or null if the pair has never been fetched. */
  lastFetchedAt: Date | null;
  /** Age in seconds since lastFetchedAt; +Infinity when never fetched. */
  ageSeconds: number;
  /** Staleness ratio age / targetAge; +Infinity when never fetched. */
  stalenessRatio: number;
}

export interface PickerOptions {
  /**
   * Minimum seconds since the last successful fetch before a symbol's
   * GLOBAL_QUOTE pair becomes eligible again. Prevents same-symbol refresh
   * storms inside a budget day. OVERVIEW + DIVIDENDS use their own long
   * target ages and ignore this floor.
   */
  minAgeSeconds: number;
  now?: Date;
  /** Override which functions participate in rotation (test seam). */
  functions?: AvWorkFunction[];
  /** Override per-function target ages in seconds (test seam). */
  targetAgeSeconds?: Partial<Record<AvWorkFunction, number>>;
}

const DAY_SECONDS = 24 * 3600;
const DEFAULT_TARGET_AGE_SECONDS: Record<AvWorkFunction, number> = {
  GLOBAL_QUOTE: 1 * DAY_SECONDS,
  DIVIDENDS: 30 * DAY_SECONDS,
  OVERVIEW: 90 * DAY_SECONDS,
};
const DEFAULT_FUNCTIONS: AvWorkFunction[] = ['GLOBAL_QUOTE', 'DIVIDENDS', 'OVERVIEW'];

async function distinctHeldSymbols(): Promise<string[]> {
  const rows = await Security.findAll({
    attributes: [[fn('DISTINCT', col('symbol')), 'symbol']],
    where: { symbol: { [Op.ne]: '' } },
    raw: true,
  });
  return rows
    .map((r) => (r as unknown as { symbol: string | null }).symbol)
    .filter((s): s is string => typeof s === 'string' && s.length > 0);
}

/** Returns `{ [function]: { [symbol]: lastFetchedAt } }` across the requested set. */
async function latestSuccessfulFetchByPair(
  symbols: string[],
  functions: AvWorkFunction[],
): Promise<Map<AvWorkFunction, Map<string, Date>>> {
  const out = new Map<AvWorkFunction, Map<string, Date>>();
  for (const fnName of functions) out.set(fnName, new Map());
  if (symbols.length === 0 || functions.length === 0) return out;

  const rows = await ProviderJobLog.findAll({
    attributes: ['function', 'symbol', [fn('MAX', col('fetched_at')), 'lastFetchedAt']],
    where: {
      provider: ALPHA_VANTAGE_PROVIDER,
      function: { [Op.in]: functions },
      status: 'ok',
      symbol: { [Op.in]: symbols },
    },
    group: ['function', 'symbol'],
    raw: true,
  });
  for (const row of rows) {
    const r = row as unknown as {
      function: AvWorkFunction | null;
      symbol: string | null;
      lastFetchedAt: Date | string | null;
    };
    if (!r.function || !r.symbol || !r.lastFetchedAt) continue;
    const ts = r.lastFetchedAt instanceof Date ? r.lastFetchedAt : new Date(r.lastFetchedAt);
    if (!Number.isFinite(ts.getTime())) continue;
    const inner = out.get(r.function);
    if (inner) inner.set(r.symbol, ts);
  }
  return out;
}

/**
 * Return the next eligible work item, or null if every (symbol, function)
 * pair is fresher than its target age (i.e. nothing is stale enough to
 * refresh right now).
 */
export async function pickNext(opts: PickerOptions): Promise<WorkItem | null> {
  const now = opts.now ?? new Date();
  const functions = opts.functions ?? DEFAULT_FUNCTIONS;
  const targets: Record<AvWorkFunction, number> = {
    ...DEFAULT_TARGET_AGE_SECONDS,
    ...opts.targetAgeSeconds,
  };

  const symbols = await distinctHeldSymbols();
  if (symbols.length === 0) return null;

  const latest = await latestSuccessfulFetchByPair(symbols, functions);

  let best: WorkItem | null = null;
  for (const symbol of symbols) {
    for (const fnName of functions) {
      const last = latest.get(fnName)?.get(symbol) ?? null;
      const ageSeconds = last
        ? Math.max(0, (now.getTime() - last.getTime()) / 1000)
        : Number.POSITIVE_INFINITY;

      // GLOBAL_QUOTE honors the per-day min-age floor to keep one symbol
      // from monopolizing the budget. Long-cadence functions skip the floor
      // because their natural target age already dwarfs it.
      if (fnName === 'GLOBAL_QUOTE' && ageSeconds < opts.minAgeSeconds) continue;

      const target = targets[fnName];
      const stalenessRatio = target > 0 ? ageSeconds / target : Number.POSITIVE_INFINITY;
      if (stalenessRatio < 1) continue;

      if (!best || stalenessRatio > best.stalenessRatio) {
        best = {
          function: fnName,
          symbol,
          lastFetchedAt: last,
          ageSeconds,
          stalenessRatio,
        };
      }
    }
  }
  return best;
}
