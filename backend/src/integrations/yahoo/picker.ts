/**
 * Pick the next (security, function) work item for the scheduler.
 *
 * Strategy: across every distinct held Security row (keyed on id so each
 * row's currency-aware Yahoo symbol can be resolved at fetch time) and
 * every function the scheduler is willing to refresh, compute each pair's
 * staleness ratio (`age / target`). Pairs that have never been fetched
 * score `+Infinity`. The eligible pair with the highest ratio wins.
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
import { toYahooSymbol } from './symbol';

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

async function latestSuccessfulFetchByPair(
  yahooSymbols: string[],
  functions: YahooWorkFunction[],
): Promise<Map<YahooWorkFunction, Map<string, Date>>> {
  const out = new Map<YahooWorkFunction, Map<string, Date>>();
  for (const fnName of functions) out.set(fnName, new Map());
  if (yahooSymbols.length === 0 || functions.length === 0) return out;

  const rows = await ProviderJobLog.findAll({
    attributes: ['function', 'symbol', [fn('MAX', col('fetched_at')), 'lastFetchedAt']],
    where: {
      provider: YAHOO_PROVIDER,
      function: { [Op.in]: functions },
      status: 'ok',
      symbol: { [Op.in]: yahooSymbols },
    },
    group: ['function', 'symbol'],
    raw: true,
  });
  for (const row of rows) {
    const r = row as unknown as {
      function: YahooWorkFunction | null;
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

export async function pickNext(opts: PickerOptions): Promise<WorkItem | null> {
  const now = opts.now ?? new Date();
  const functions = opts.functions ?? DEFAULT_FUNCTIONS;
  const targets: Record<YahooWorkFunction, number> = {
    ...DEFAULT_TARGET_AGE_SECONDS,
    ...opts.targetAgeSeconds,
  };

  const securities = await eligibleSecurities();
  if (securities.length === 0) return null;
  const primaryFor = (s: (typeof securities)[number]) =>
    toYahooSymbol(s.symbol, s.currency, { assetType: s.assetType, name: s.name });
  const resolvable = securities.filter((s) => primaryFor(s) !== '');
  if (resolvable.length === 0) return null;
  const yahooSymbols = Array.from(new Set(resolvable.map(primaryFor)));
  const latest = await latestSuccessfulFetchByPair(yahooSymbols, functions);

  let best: WorkItem | null = null;
  for (const s of resolvable) {
    const yahooSymbol = primaryFor(s);
    for (const fnName of functions) {
      const last = latest.get(fnName)?.get(yahooSymbol) ?? null;
      const ageSeconds = last
        ? Math.max(0, (now.getTime() - last.getTime()) / 1000)
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
          lastFetchedAt: last,
          ageSeconds,
          stalenessRatio,
        };
      }
    }
  }
  return best;
}
