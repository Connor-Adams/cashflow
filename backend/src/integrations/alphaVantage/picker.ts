/**
 * Pick the next (symbol, function) work item for the scheduler.
 *
 * Strategy: across all distinct held symbols, find the one whose most recent
 * successful provider call is the oldest, subject to a minimum-age floor that
 * prevents the scheduler from hammering a single symbol within one budget day.
 *
 * Symbols are global — the same AAPL quote serves every household — so the
 * picker keys on `symbol` rather than on Security.id.
 */

import { Op, fn, col } from 'sequelize';
import { Security } from '../../models/Security';
import { ProviderJobLog } from '../../models/ProviderJobLog';
import { ALPHA_VANTAGE_PROVIDER } from './budget';

export type AvWorkFunction = 'GLOBAL_QUOTE';

export interface WorkItem {
  function: AvWorkFunction;
  symbol: string;
  /** Last successful fetch timestamp, or null if the symbol has never been fetched. */
  lastFetchedAt: Date | null;
  /** Age in seconds since lastFetchedAt; Number.POSITIVE_INFINITY when never fetched. */
  ageSeconds: number;
}

export interface PickerOptions {
  /**
   * Minimum seconds since the last successful fetch before a symbol becomes
   * eligible again. Prevents same-symbol refresh storms inside a budget day.
   */
  minAgeSeconds: number;
  now?: Date;
}

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

async function latestSuccessfulFetchBySymbol(
  symbols: string[],
  fnName: AvWorkFunction,
): Promise<Map<string, Date>> {
  if (symbols.length === 0) return new Map();
  const rows = await ProviderJobLog.findAll({
    attributes: ['symbol', [fn('MAX', col('fetched_at')), 'lastFetchedAt']],
    where: {
      provider: ALPHA_VANTAGE_PROVIDER,
      function: fnName,
      status: 'ok',
      symbol: { [Op.in]: symbols },
    },
    group: ['symbol'],
    raw: true,
  });
  const out = new Map<string, Date>();
  for (const row of rows) {
    const r = row as unknown as { symbol: string | null; lastFetchedAt: Date | string | null };
    if (!r.symbol || !r.lastFetchedAt) continue;
    const ts = r.lastFetchedAt instanceof Date ? r.lastFetchedAt : new Date(r.lastFetchedAt);
    if (Number.isFinite(ts.getTime())) out.set(r.symbol, ts);
  }
  return out;
}

/**
 * Return the next eligible work item, or null if every symbol is fresher than
 * the min-age floor (i.e. nothing is stale enough to refresh right now).
 */
export async function pickNext(opts: PickerOptions): Promise<WorkItem | null> {
  const now = opts.now ?? new Date();
  const symbols = await distinctHeldSymbols();
  if (symbols.length === 0) return null;

  const latest = await latestSuccessfulFetchBySymbol(symbols, 'GLOBAL_QUOTE');

  let best: WorkItem | null = null;
  for (const symbol of symbols) {
    const last = latest.get(symbol) ?? null;
    const ageSeconds = last
      ? Math.max(0, (now.getTime() - last.getTime()) / 1000)
      : Number.POSITIVE_INFINITY;
    if (ageSeconds < opts.minAgeSeconds) continue;
    if (!best || ageSeconds > best.ageSeconds) {
      best = {
        function: 'GLOBAL_QUOTE',
        symbol,
        lastFetchedAt: last,
        ageSeconds,
      };
    }
  }
  return best;
}
