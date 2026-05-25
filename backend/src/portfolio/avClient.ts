/**
 * Thin Alpha Vantage HTTP wrappers. Each function returns parsed data
 * (or null when AV reports "not found") and throws on transport / rate-
 * limit / API-key errors so callers can surface meaningful messages.
 *
 * AV rate-limit responses come back as HTTP 200 with a JSON body like
 * `{ "Note": "Thank you for using Alpha Vantage! Our standard API ..." }`
 * — we detect that explicitly.
 */
import * as env from '../config/env';

export type AvDailyBar = {
  date: string;          // 'YYYY-MM-DD'
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  adjClose: number;
  volume: number | null;
};

export type AvDividendEvent = {
  exDividendDate: string;
  declarationDate: string | null;
  recordDate: string | null;
  paymentDate: string | null;
  amount: number;
  currency: string;
};

export type AvOverview = {
  sector: string | null;
  industry: string | null;
  country: string | null;
  exchange: string | null;
  description: string | null;
  raw: Record<string, unknown>;
};

const BASE = 'https://www.alphavantage.co/query';

function nReq(): string {
  if (!env.alphaVantageApiKey) {
    throw new Error('ALPHA_VANTAGE_API_KEY is not configured');
  }
  return env.alphaVantageApiKey;
}

function n(v: unknown): number | null {
  if (v == null || v === '') return null;
  const x = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(x) ? x : null;
}

function detectRateLimit(json: Record<string, unknown>): void {
  const note = json['Note'] ?? json['Information'];
  if (typeof note === 'string' && /thank you for using alpha vantage|rate limit|standard api/i.test(note)) {
    throw new Error('Alpha Vantage rate limit: ' + note);
  }
}

export async function fetchDailyAdjusted(
  symbol: string,
  outputsize: 'compact' | 'full',
  fetchImpl: typeof fetch = fetch,
): Promise<AvDailyBar[] | null> {
  const url = new URL(BASE);
  url.searchParams.set('function', 'TIME_SERIES_DAILY_ADJUSTED');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('outputsize', outputsize);
  url.searchParams.set('apikey', nReq());
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`Alpha Vantage HTTP ${res.status}`);
  const json = (await res.json()) as Record<string, unknown>;
  detectRateLimit(json);
  const series = json['Time Series (Daily)'] as Record<string, Record<string, string>> | undefined;
  if (!series) return null;
  const rows: AvDailyBar[] = [];
  for (const [date, row] of Object.entries(series)) {
    const close = n(row['4. close']);
    const adj = n(row['5. adjusted close']);
    if (close == null || adj == null) continue;
    rows.push({
      date,
      open: n(row['1. open']),
      high: n(row['2. high']),
      low: n(row['3. low']),
      close,
      adjClose: adj,
      volume: n(row['6. volume']),
    });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return rows;
}

export async function fetchDividends(
  symbol: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AvDividendEvent[] | null> {
  const url = new URL(BASE);
  url.searchParams.set('function', 'DIVIDENDS');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('apikey', nReq());
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`Alpha Vantage HTTP ${res.status}`);
  const json = (await res.json()) as Record<string, unknown>;
  detectRateLimit(json);
  const data = json['data'] as Array<Record<string, string>> | undefined;
  if (!Array.isArray(data)) return null;
  const out: AvDividendEvent[] = [];
  for (const row of data) {
    const amount = n(row['amount']);
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
): Promise<AvOverview | null> {
  const url = new URL(BASE);
  url.searchParams.set('function', 'OVERVIEW');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('apikey', nReq());
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`Alpha Vantage HTTP ${res.status}`);
  const json = (await res.json()) as Record<string, unknown>;
  detectRateLimit(json);
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
