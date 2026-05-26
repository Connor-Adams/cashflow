/**
 * Yahoo Finance HTTP client.
 *
 * Pure I/O — no DB writes, no quota accounting. Yahoo's public API has no
 * per-key quota; we log every call to `provider_job_log` for diagnostics
 * but never gate work on a daily budget.
 *
 * All exported fetchers throw `YahooFinanceError` on transport or upstream
 * failures and return `null` when Yahoo responded successfully but had no
 * usable data for the symbol (unknown ticker, empty series, etc.). The
 * distinction lets callers record `not_found` separately from retryable
 * errors.
 *
 * Each fetcher accepts an optional `client` so tests can inject a stub
 * without monkey-patching the singleton.
 */
import YahooFinance from 'yahoo-finance2';
import type {
  ChartEventDividend,
  ChartResultArray,
} from 'yahoo-finance2/script/src/modules/chart';
import type { Quote } from 'yahoo-finance2/script/src/modules/quote';
import type { QuoteSummaryResult } from 'yahoo-finance2/script/src/modules/quoteSummary-iface';

export const YAHOO_PROVIDER = 'yahoo';

export interface QuoteResult {
  price: number;
  pricedAt: Date;
  currency: string | null;
  previousClose: number | null;
}

export interface DailyBar {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  adjClose: number;
  volume: number | null;
}

export interface DividendEvent {
  exDividendDate: string;
  declarationDate: string | null;
  recordDate: string | null;
  paymentDate: string | null;
  amount: number;
  currency: string;
}

export interface OverviewResult {
  sector: string | null;
  industry: string | null;
  country: string | null;
  exchange: string | null;
  description: string | null;
  raw: Record<string, unknown>;
}

export class YahooFinanceError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = 'YahooFinanceError';
  }
}

/**
 * Loose facade over the upstream client so we can stub it in tests without
 * dragging in `ModuleThis` / `_moduleExec` plumbing.
 */
export interface YahooClient {
  quote(symbol: string): Promise<Quote | Quote[] | null>;
  chart(symbol: string, opts: ChartQueryOptions): Promise<ChartResultArray>;
  quoteSummary(
    symbol: string,
    opts: { modules: string[] },
  ): Promise<QuoteSummaryResult>;
}

export interface ChartQueryOptions {
  period1: Date | string | number;
  period2?: Date | string | number;
  interval?: '1d' | '1wk' | '1mo';
  events?: string;
  return?: 'array';
}

let singleton: YahooClient | null = null;
function getClient(): YahooClient {
  if (!singleton) {
    const instance = new YahooFinance({
      suppressNotices: ['yahooSurvey', 'ripHistorical'],
    });
    singleton = {
      quote: (s) => instance.quote(s) as Promise<Quote | Quote[] | null>,
      chart: (s, o) =>
        instance.chart(s, {
          period1: o.period1,
          period2: o.period2,
          interval: o.interval,
          events: o.events,
          return: 'array',
        }) as Promise<ChartResultArray>,
      quoteSummary: (s, o) =>
        instance.quoteSummary(s, { modules: o.modules as never }) as Promise<QuoteSummaryResult>,
    };
  }
  return singleton;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function wrapError(err: unknown, context: string): never {
  if (err instanceof YahooFinanceError) throw err;
  const message = err instanceof Error ? err.message : String(err);
  const httpStatus =
    err && typeof err === 'object' && 'response' in err
      ? (err as { response?: { status?: number } }).response?.status ?? null
      : null;
  throw new YahooFinanceError(`${context}: ${message}`, httpStatus);
}

export async function fetchQuote(
  yahooSymbol: string,
  client: YahooClient = getClient(),
): Promise<QuoteResult | null> {
  let q;
  try {
    q = await client.quote(yahooSymbol);
  } catch (err) {
    wrapError(err, `quote(${yahooSymbol}) failed`);
  }
  if (q == null || Array.isArray(q)) return null;
  const price = q.regularMarketPrice;
  if (typeof price !== 'number' || !Number.isFinite(price)) return null;
  const pricedAt =
    q.regularMarketTime instanceof Date ? q.regularMarketTime : new Date();
  const previousClose =
    typeof q.regularMarketPreviousClose === 'number'
      ? q.regularMarketPreviousClose
      : null;
  return {
    price,
    pricedAt,
    currency: typeof q.currency === 'string' ? q.currency : null,
    previousClose,
  };
}

export async function fetchDailyHistory(
  yahooSymbol: string,
  opts: { period1: Date | string },
  client: YahooClient = getClient(),
): Promise<DailyBar[] | null> {
  let result;
  try {
    result = await client.chart(yahooSymbol, {
      period1: opts.period1,
      interval: '1d',
      events: 'div|split',
      return: 'array',
    });
  } catch (err) {
    wrapError(err, `chart(${yahooSymbol}) failed`);
  }
  const quotes = result?.quotes;
  if (!quotes || quotes.length === 0) return null;
  const bars: DailyBar[] = [];
  for (const q of quotes) {
    if (q.close == null) continue;
    const close = Number(q.close);
    if (!Number.isFinite(close)) continue;
    const adj =
      typeof q.adjclose === 'number' && Number.isFinite(q.adjclose)
        ? q.adjclose
        : close;
    bars.push({
      date: isoDate(q.date),
      open: typeof q.open === 'number' && Number.isFinite(q.open) ? q.open : null,
      high: typeof q.high === 'number' && Number.isFinite(q.high) ? q.high : null,
      low: typeof q.low === 'number' && Number.isFinite(q.low) ? q.low : null,
      close,
      adjClose: adj,
      volume:
        typeof q.volume === 'number' && Number.isFinite(q.volume)
          ? q.volume
          : null,
    });
  }
  bars.sort((a, b) => a.date.localeCompare(b.date));
  return bars.length === 0 ? null : bars;
}

/**
 * Yahoo embeds dividend events inside the chart payload. Pulling a 5-year
 * window covers the TTM math used by yield-on-cost and is more than enough
 * for the dividend-history surface in the UI.
 */
export async function fetchDividends(
  yahooSymbol: string,
  opts: { period1?: Date | string } = {},
  client: YahooClient = getClient(),
): Promise<DividendEvent[] | null> {
  const period1 =
    opts.period1 ?? new Date(Date.now() - 5 * 365 * 86400000);
  let result;
  try {
    result = await client.chart(yahooSymbol, {
      period1,
      interval: '1d',
      events: 'div',
      return: 'array',
    });
  } catch (err) {
    wrapError(err, `dividends(${yahooSymbol}) failed`);
  }
  const events = result?.events?.dividends ?? [];
  if (!Array.isArray(events)) return [];
  const currency =
    asString(result?.meta?.currency) ?? 'USD';
  const out: DividendEvent[] = events
    .filter(
      (e: ChartEventDividend) =>
        typeof e.amount === 'number' &&
        Number.isFinite(e.amount) &&
        e.date instanceof Date,
    )
    .map((e: ChartEventDividend) => ({
      exDividendDate: isoDate(e.date),
      declarationDate: null,
      recordDate: null,
      paymentDate: null,
      amount: e.amount,
      currency,
    }));
  out.sort((a, b) => a.exDividendDate.localeCompare(b.exDividendDate));
  return out;
}

export async function fetchOverview(
  yahooSymbol: string,
  client: YahooClient = getClient(),
): Promise<OverviewResult | null> {
  let summary;
  try {
    summary = await client.quoteSummary(yahooSymbol, {
      modules: ['assetProfile', 'summaryProfile', 'price'],
    });
  } catch (err) {
    wrapError(err, `quoteSummary(${yahooSymbol}) failed`);
  }
  if (!summary) return null;
  const asset = summary.assetProfile;
  const summaryProfile = summary.summaryProfile;
  const price = summary.price as Record<string, unknown> | undefined;
  const sector = asString(asset?.sector) ?? asString(summaryProfile?.sector);
  const industry =
    asString(asset?.industry) ?? asString(summaryProfile?.industry);
  const country =
    asString(asset?.country) ?? asString(summaryProfile?.country);
  const exchange =
    asString(price?.fullExchangeName) ??
    asString(price?.exchangeName) ??
    asString(price?.exchange);
  const description =
    asString(asset?.longBusinessSummary) ??
    asString(summaryProfile?.longBusinessSummary) ??
    asString(asset?.description) ??
    asString(summaryProfile?.description);
  if (
    sector == null &&
    industry == null &&
    country == null &&
    exchange == null &&
    description == null
  ) {
    return null;
  }
  return {
    sector,
    industry,
    country,
    exchange,
    description,
    raw: summary as unknown as Record<string, unknown>,
  };
}

/** Test seam — swaps the underlying client. Pass null to restore the singleton. */
export function __setYahooClient(stub: YahooClient | null): void {
  singleton = stub;
}
