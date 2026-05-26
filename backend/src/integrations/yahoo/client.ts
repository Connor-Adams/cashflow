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
  ChartOptionsWithReturnArray,
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
  /** Snapshot quote data from the `price` module. */
  regularMarketPrice: number | null;
  previousClose: number | null;
  /** Market data — `summaryDetail` + `defaultKeyStatistics`. */
  marketCap: number | null;
  trailingPE: number | null;
  forwardPE: number | null;
  trailingEps: number | null;
  forwardEps: number | null;
  beta: number | null;
  dayLow: number | null;
  dayHigh: number | null;
  fiftyTwoWeekLow: number | null;
  fiftyTwoWeekHigh: number | null;
  fiftyDayAverage: number | null;
  twoHundredDayAverage: number | null;
  volume: number | null;
  averageVolume: number | null;
  averageVolume10days: number | null;
  sharesOutstanding: number | null;
  priceToBook: number | null;
  bookValue: number | null;
  /** Dividend stats — `summaryDetail`. */
  dividendRate: number | null;
  dividendYield: number | null;
  fiveYearAvgDividendYield: number | null;
  payoutRatio: number | null;
  exDividendDate: string | null;
  /** Fundamentals — `financialData`. */
  totalRevenue: number | null;
  revenuePerShare: number | null;
  grossMargins: number | null;
  operatingMargins: number | null;
  profitMargins: number | null;
  ebitdaMargins: number | null;
  returnOnAssets: number | null;
  returnOnEquity: number | null;
  totalCash: number | null;
  totalDebt: number | null;
  debtToEquity: number | null;
  freeCashflow: number | null;
  operatingCashflow: number | null;
  /** Analyst data — `financialData`. */
  targetMeanPrice: number | null;
  targetHighPrice: number | null;
  targetLowPrice: number | null;
  recommendationMean: number | null;
  recommendationKey: string | null;
  numberOfAnalystOpinions: number | null;
  /** Currency this issuer reports in (often differs from listing currency). */
  financialCurrency: string | null;
  /** Crypto-only fields — `summaryDetail` for cryptocurrency symbols. */
  circulatingSupply: number | null;
  volume24Hr: number | null;
  cryptoStartDate: string | null;
  fromCurrency: string | null;
  /**
   * Fund / ETF fields — `fundProfile`, `topHoldings`, `fundPerformance`.
   * `null` outside the fund domain (most equities, all crypto).
   */
  fundFamily: string | null;
  fundCategory: string | null;
  fundLegalType: string | null;
  fundExpenseRatio: number | null;
  fundTotalAssets: number | null;
  fundYield: number | null;
  topHoldings: TopHoldingEntry[] | null;
  sectorWeightings: Record<string, number> | null;
  bondPosition: number | null;
  stockPosition: number | null;
  cashPosition: number | null;
  /** Trailing total return windows from `fundPerformance.trailingReturns`. */
  trailingReturn1y: number | null;
  trailingReturn3y: number | null;
  trailingReturn5y: number | null;
  trailingReturn10y: number | null;
  trailingReturnYtd: number | null;
  raw: Record<string, unknown>;
}

export interface TopHoldingEntry {
  symbol: string | null;
  name: string | null;
  percent: number | null;
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

/**
 * yahoo-finance2 logs invalid-options validation failures via
 * `logger.error(headline)` immediately followed by `logger.info(JSON.stringify(...))`
 * (the latter through its internal logObj helper on non-TTY runtimes).
 *
 * In Railway these surface as `level=error`, drowning out genuine errors when a
 * scheduler iterates many symbols. The validator still throws InvalidOptionsError
 * either way, so the call site already learns about the failure. Demote the
 * companion log lines to `warn` so they remain searchable without polluting
 * the error stream. The synchronous error→info pairing inside `validate()` is
 * safe to track with a module-level flag because Node's event loop never
 * interleaves synchronous JS between the two calls.
 */
function createDemotingLogger() {
  let pendingOptionsDump = false;
  const isOptionsErrorHeadline = (args: unknown[]): boolean => {
    const first = args[0];
    return (
      typeof first === 'string' &&
      first.startsWith('[yahooFinance.') &&
      first.includes('Invalid options')
    );
  };
  return {
    info: (...args: unknown[]) => {
      if (pendingOptionsDump) {
        pendingOptionsDump = false;
        console.warn(...args);
        return;
      }
      console.log(...args);
    },
    warn: (...args: unknown[]) => console.warn(...args),
    error: (...args: unknown[]) => {
      if (isOptionsErrorHeadline(args)) {
        pendingOptionsDump = true;
        console.warn(...args);
        return;
      }
      console.error(...args);
    },
    debug: (..._args: unknown[]) => {},
    dir: (item: unknown, options?: unknown) =>
      console.dir(item, options as Parameters<typeof console.dir>[1]),
  };
}

let singleton: YahooClient | null = null;
function getClient(): YahooClient {
  if (!singleton) {
    const instance = new YahooFinance({
      suppressNotices: ['yahooSurvey', 'ripHistorical'],
      validation: { logOptionsErrors: true },
      logger: createDemotingLogger(),
    });
    singleton = {
      quote: (s) => instance.quote(s) as Promise<Quote | Quote[] | null>,
      chart: (s, o) => {
        const chartOpts: ChartOptionsWithReturnArray = {
          period1: o.period1,
          interval: o.interval,
          events: o.events,
          return: 'array',
        };
        if (o.period2 !== undefined) chartOpts.period2 = o.period2;
        return instance.chart(s, chartOpts) as Promise<ChartResultArray>;
      },
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

/**
 * Yahoo `quoteSummary` values often arrive as either a bare number or as
 * `{ raw: number, fmt: string }`. Coerce both shapes to a plain finite number,
 * dropping anything else (null, NaN, strings, etc.).
 */
function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value && typeof value === 'object' && 'raw' in value) {
    const raw = (value as { raw: unknown }).raw;
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  }
  return null;
}

function asDateString(value: unknown): string | null {
  if (value instanceof Date) return isoDate(value);
  if (typeof value === 'string' && value.trim() !== '') return value.slice(0, 10);
  if (value && typeof value === 'object' && 'raw' in value) {
    const raw = (value as { raw: unknown }).raw;
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return isoDate(new Date(raw * 1000));
    }
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return isoDate(new Date(value * 1000));
  }
  return null;
}

export async function fetchOverview(
  yahooSymbol: string,
  client: YahooClient = getClient(),
): Promise<OverviewResult | null> {
  let summary;
  try {
    summary = await client.quoteSummary(yahooSymbol, {
      modules: [
        'assetProfile',
        'summaryProfile',
        'price',
        'summaryDetail',
        'defaultKeyStatistics',
        'financialData',
        // Fund-only modules — silently absent for equities/crypto, populated
        // for ETFs and mutual funds.
        'fundProfile',
        'topHoldings',
        'fundPerformance',
      ],
    });
  } catch (err) {
    wrapError(err, `quoteSummary(${yahooSymbol}) failed`);
  }
  if (!summary) return null;
  const asset = summary.assetProfile as Record<string, unknown> | undefined;
  const summaryProfile = summary.summaryProfile as Record<string, unknown> | undefined;
  const price = summary.price as Record<string, unknown> | undefined;
  const detail = summary.summaryDetail as Record<string, unknown> | undefined;
  const stats = summary.defaultKeyStatistics as Record<string, unknown> | undefined;
  const fin = summary.financialData as Record<string, unknown> | undefined;
  const fundProfile = summary.fundProfile as Record<string, unknown> | undefined;
  const topHoldingsMod = summary.topHoldings as Record<string, unknown> | undefined;
  const fundPerf = summary.fundPerformance as Record<string, unknown> | undefined;
  const sector =
    asString(asset?.['sector']) ?? asString(summaryProfile?.['sector']);
  const industry =
    asString(asset?.['industry']) ?? asString(summaryProfile?.['industry']);
  const country =
    asString(asset?.['country']) ?? asString(summaryProfile?.['country']);
  const exchange =
    asString(price?.['fullExchangeName']) ??
    asString(price?.['exchangeName']) ??
    asString(price?.['exchange']);
  const description =
    asString(asset?.['longBusinessSummary']) ??
    asString(summaryProfile?.['longBusinessSummary']) ??
    asString(asset?.['description']) ??
    asString(summaryProfile?.['description']);

  const result: OverviewResult = {
    sector,
    industry,
    country,
    exchange,
    description,
    regularMarketPrice:
      asNumber(price?.['regularMarketPrice']) ??
      asNumber(fin?.['currentPrice']) ??
      asNumber(detail?.['regularMarketPrice']),
    previousClose:
      asNumber(detail?.['previousClose']) ??
      asNumber(price?.['regularMarketPreviousClose']),
    marketCap:
      asNumber(detail?.['marketCap']) ?? asNumber(price?.['marketCap']),
    trailingPE: asNumber(detail?.['trailingPE']),
    forwardPE: asNumber(detail?.['forwardPE']) ?? asNumber(stats?.['forwardPE']),
    trailingEps: asNumber(stats?.['trailingEps']),
    forwardEps: asNumber(stats?.['forwardEps']),
    beta: asNumber(detail?.['beta']) ?? asNumber(stats?.['beta']),
    dayLow: asNumber(detail?.['dayLow']) ?? asNumber(price?.['regularMarketDayLow']),
    dayHigh: asNumber(detail?.['dayHigh']) ?? asNumber(price?.['regularMarketDayHigh']),
    fiftyTwoWeekLow: asNumber(detail?.['fiftyTwoWeekLow']) ?? asNumber(stats?.['fiftyTwoWeekLow']),
    fiftyTwoWeekHigh: asNumber(detail?.['fiftyTwoWeekHigh']) ?? asNumber(stats?.['fiftyTwoWeekHigh']),
    fiftyDayAverage: asNumber(detail?.['fiftyDayAverage']),
    twoHundredDayAverage: asNumber(detail?.['twoHundredDayAverage']),
    volume: asNumber(detail?.['volume']) ?? asNumber(price?.['regularMarketVolume']),
    averageVolume: asNumber(detail?.['averageVolume']),
    averageVolume10days: asNumber(detail?.['averageVolume10days']),
    sharesOutstanding: asNumber(stats?.['sharesOutstanding']),
    priceToBook: asNumber(stats?.['priceToBook']) ?? asNumber(detail?.['priceToBook']),
    bookValue: asNumber(stats?.['bookValue']),
    dividendRate:
      asNumber(detail?.['dividendRate']) ?? asNumber(detail?.['trailingAnnualDividendRate']),
    dividendYield:
      asNumber(detail?.['dividendYield']) ?? asNumber(detail?.['trailingAnnualDividendYield']),
    fiveYearAvgDividendYield: asNumber(detail?.['fiveYearAvgDividendYield']),
    payoutRatio: asNumber(detail?.['payoutRatio']),
    exDividendDate: asDateString(detail?.['exDividendDate']),
    totalRevenue: asNumber(fin?.['totalRevenue']),
    revenuePerShare: asNumber(fin?.['revenuePerShare']),
    grossMargins: asNumber(fin?.['grossMargins']),
    operatingMargins: asNumber(fin?.['operatingMargins']),
    profitMargins: asNumber(fin?.['profitMargins']) ?? asNumber(stats?.['profitMargins']),
    ebitdaMargins: asNumber(fin?.['ebitdaMargins']),
    returnOnAssets: asNumber(fin?.['returnOnAssets']),
    returnOnEquity: asNumber(fin?.['returnOnEquity']),
    totalCash: asNumber(fin?.['totalCash']),
    totalDebt: asNumber(fin?.['totalDebt']),
    debtToEquity: asNumber(fin?.['debtToEquity']),
    freeCashflow: asNumber(fin?.['freeCashflow']),
    operatingCashflow: asNumber(fin?.['operatingCashflow']),
    targetMeanPrice: asNumber(fin?.['targetMeanPrice']),
    targetHighPrice: asNumber(fin?.['targetHighPrice']),
    targetLowPrice: asNumber(fin?.['targetLowPrice']),
    recommendationMean: asNumber(fin?.['recommendationMean']),
    recommendationKey: asString(fin?.['recommendationKey']),
    numberOfAnalystOpinions: asNumber(fin?.['numberOfAnalystOpinions']),
    financialCurrency: asString(fin?.['financialCurrency']),
    circulatingSupply: asNumber(detail?.['circulatingSupply']),
    volume24Hr: asNumber(detail?.['volume24Hr']),
    cryptoStartDate: asDateString(detail?.['startDate']),
    fromCurrency: asString(detail?.['fromCurrency']),
    fundFamily: asString(fundProfile?.['family']),
    fundCategory: asString(fundProfile?.['categoryName']),
    fundLegalType: asString(fundProfile?.['legalType']),
    fundExpenseRatio: extractExpenseRatio(fundProfile),
    fundTotalAssets:
      extractFromFees(fundProfile, 'totalNetAssets') ??
      asNumber(detail?.['totalAssets']),
    fundYield: asNumber(detail?.['yield']),
    topHoldings: extractTopHoldings(topHoldingsMod),
    sectorWeightings: extractSectorWeightings(topHoldingsMod),
    bondPosition: asNumber(topHoldingsMod?.['bondPosition']),
    stockPosition: asNumber(topHoldingsMod?.['stockPosition']),
    cashPosition: asNumber(topHoldingsMod?.['cashPosition']),
    trailingReturn1y: extractTrailingReturn(fundPerf, 'oneYear'),
    trailingReturn3y: extractTrailingReturn(fundPerf, 'threeYear'),
    trailingReturn5y: extractTrailingReturn(fundPerf, 'fiveYear'),
    trailingReturn10y: extractTrailingReturn(fundPerf, 'tenYear'),
    trailingReturnYtd: extractTrailingReturn(fundPerf, 'ytd'),
    raw: summary as unknown as Record<string, unknown>,
  };

  const hasAnySignal = Object.entries(result).some(([k, v]) => {
    if (k === 'raw') return false;
    if (v == null) return false;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'object') return Object.keys(v).length > 0;
    return true;
  });
  return hasAnySignal ? result : null;
}

function extractFromFees(
  fundProfile: Record<string, unknown> | undefined,
  key: string,
): number | null {
  if (!fundProfile) return null;
  const fees = fundProfile['feesExpensesInvestment'] as
    | Record<string, unknown>
    | undefined;
  return asNumber(fees?.[key]);
}

function extractExpenseRatio(
  fundProfile: Record<string, unknown> | undefined,
): number | null {
  // Prefer net (what the investor actually pays); fall back to gross then
  // the annual report ratio. Yahoo populates whichever it has.
  return (
    extractFromFees(fundProfile, 'netExpRatio') ??
    extractFromFees(fundProfile, 'grossExpRatio') ??
    extractFromFees(fundProfile, 'annualReportExpenseRatio')
  );
}

function extractTopHoldings(
  topHoldingsMod: Record<string, unknown> | undefined,
): TopHoldingEntry[] | null {
  const arr = topHoldingsMod?.['holdings'];
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const out: TopHoldingEntry[] = [];
  for (const h of arr) {
    if (!h || typeof h !== 'object') continue;
    const rec = h as Record<string, unknown>;
    const symbol = asString(rec['symbol']);
    const name = asString(rec['holdingName']);
    const percent = asNumber(rec['holdingPercent']);
    if (symbol == null && name == null) continue;
    out.push({ symbol, name, percent });
  }
  return out.length === 0 ? null : out;
}

function extractSectorWeightings(
  topHoldingsMod: Record<string, unknown> | undefined,
): Record<string, number> | null {
  const arr = topHoldingsMod?.['sectorWeightings'];
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const out: Record<string, number> = {};
  for (const entry of arr) {
    if (!entry || typeof entry !== 'object') continue;
    for (const [k, v] of Object.entries(entry as Record<string, unknown>)) {
      const n = asNumber(v);
      if (n != null) out[k] = n;
    }
  }
  return Object.keys(out).length === 0 ? null : out;
}

function extractTrailingReturn(
  fundPerf: Record<string, unknown> | undefined,
  field: string,
): number | null {
  if (!fundPerf) return null;
  const trailing = fundPerf['trailingReturns'] as
    | Record<string, unknown>
    | undefined;
  return asNumber(trailing?.[field]);
}

/** Test seam — swaps the underlying client. Pass null to restore the singleton. */
export function __setYahooClient(stub: YahooClient | null): void {
  singleton = stub;
}
