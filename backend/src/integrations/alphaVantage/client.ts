/**
 * Alpha Vantage HTTP client.
 *
 * Pure I/O — no DB writes, no budget enforcement. Callers are responsible for
 * checking the budget before invoking and for recording the call afterwards
 * via budget.recordCall().
 *
 * All exported fetchers throw `AlphaVantageError` on:
 *   - HTTP failures (`httpStatus` is set)
 *   - Alpha Vantage's free-tier rate-limit / quota payloads (HTTP 200 with a
 *     `Note` / `Information` / `Error Message` body; `providerNote` is set)
 *   - Missing `ALPHA_VANTAGE_API_KEY`
 *
 * They return `null` when AV responded successfully but had no usable data
 * for the symbol (unknown ticker, empty series, etc.). Differentiating the
 * two lets callers count "404-ish" results toward the daily budget but not
 * toward retry/back-off logic.
 *
 * Each fetcher accepts an optional `fetchImpl` so tests can inject a stub
 * without having to monkey-patch the global `fetch`.
 */

import * as env from '../../config/env';

export type AlphaVantageFunction =
  | 'GLOBAL_QUOTE'
  | 'TIME_SERIES_DAILY_ADJUSTED'
  | 'DIVIDENDS'
  | 'OVERVIEW';

export interface QuoteResult {
  price: number;
  pricedAt: Date;
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

export class AlphaVantageError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number | null,
    public readonly providerNote: string | null = null,
  ) {
    super(message);
    this.name = 'AlphaVantageError';
  }
}

const BASE_URL = 'https://www.alphavantage.co/query';

function requireApiKey(): string {
  if (!env.alphaVantageApiKey) {
    throw new AlphaVantageError(
      'ALPHA_VANTAGE_API_KEY is not configured',
      null,
    );
  }
  return env.alphaVantageApiKey;
}

function toFiniteNumber(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Detect Alpha Vantage's free-tier rate-limit / "no quotes" payloads. These
 * arrive as 200 OK with a `Note`, `Information`, or `Error Message` field
 * instead of the requested data, so the HTTP layer thinks everything is fine.
 */
function detectProviderMessage(json: Record<string, unknown>): string | null {
  const candidates = ['Note', 'Information', 'Error Message'];
  for (const key of candidates) {
    const value = json[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

async function callAlphaVantage(
  params: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const url = new URL(BASE_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('apikey', requireApiKey());

  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new AlphaVantageError(
      `Alpha Vantage returned HTTP ${response.status}`,
      response.status,
    );
  }
  const json = (await response.json()) as Record<string, unknown>;
  const providerMessage = detectProviderMessage(json);
  if (providerMessage) {
    throw new AlphaVantageError(providerMessage, 200, providerMessage);
  }
  return json;
}

export async function fetchGlobalQuote(
  symbol: string,
  fetchImpl: typeof fetch = fetch,
): Promise<QuoteResult | null> {
  const json = await callAlphaVantage(
    { function: 'GLOBAL_QUOTE', symbol },
    fetchImpl,
  );
  const quote = json['Global Quote'] as Record<string, string> | undefined;
  const price = toFiniteNumber(quote?.['05. price']);
  if (price == null) return null;
  const latestDay = quote?.['07. latest trading day'];
  return {
    price,
    pricedAt: latestDay ? new Date(`${latestDay}T21:00:00.000Z`) : new Date(),
  };
}

export async function fetchDailyAdjusted(
  symbol: string,
  outputsize: 'compact' | 'full',
  fetchImpl: typeof fetch = fetch,
): Promise<DailyBar[] | null> {
  const json = await callAlphaVantage(
    { function: 'TIME_SERIES_DAILY_ADJUSTED', symbol, outputsize },
    fetchImpl,
  );
  const series = json['Time Series (Daily)'] as
    | Record<string, Record<string, string>>
    | undefined;
  if (!series) return null;
  const rows: DailyBar[] = [];
  for (const [date, row] of Object.entries(series)) {
    const close = toFiniteNumber(row['4. close']);
    const adj = toFiniteNumber(row['5. adjusted close']);
    if (close == null || adj == null) continue;
    rows.push({
      date,
      open: toFiniteNumber(row['1. open']),
      high: toFiniteNumber(row['2. high']),
      low: toFiniteNumber(row['3. low']),
      close,
      adjClose: adj,
      volume: toFiniteNumber(row['6. volume']),
    });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return rows;
}

export async function fetchDividends(
  symbol: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DividendEvent[] | null> {
  const json = await callAlphaVantage(
    { function: 'DIVIDENDS', symbol },
    fetchImpl,
  );
  const data = json['data'] as Array<Record<string, string>> | undefined;
  if (!Array.isArray(data)) return null;
  const out: DividendEvent[] = [];
  for (const row of data) {
    const amount = toFiniteNumber(row['amount']);
    const ex = row['ex_dividend_date'];
    if (amount == null || !ex) continue;
    out.push({
      exDividendDate: ex,
      declarationDate: row['declaration_date'] || null,
      recordDate: row['record_date'] || null,
      paymentDate: row['payment_date'] || null,
      amount,
      currency: row['currency'] || 'USD',
    });
  }
  out.sort((a, b) => a.exDividendDate.localeCompare(b.exDividendDate));
  return out;
}

export async function fetchOverview(
  symbol: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OverviewResult | null> {
  const json = await callAlphaVantage(
    { function: 'OVERVIEW', symbol },
    fetchImpl,
  );
  if (!json['Symbol']) return null;
  const str = (k: string): string | null => {
    const v = json[k];
    return typeof v === 'string' && v !== 'None' && v !== '' ? v : null;
  };
  return {
    sector: str('Sector'),
    industry: str('Industry'),
    country: str('Country'),
    exchange: str('Exchange'),
    description: str('Description'),
    raw: json,
  };
}
