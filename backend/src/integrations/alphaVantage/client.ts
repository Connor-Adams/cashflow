/**
 * Alpha Vantage HTTP client.
 *
 * Pure I/O — no DB writes, no budget enforcement. Callers are responsible for
 * checking the budget before invoking and for recording the call afterwards
 * via budget.recordCall().
 */

import * as env from '../../config/env';

export type AlphaVantageFunction = 'GLOBAL_QUOTE';

export interface QuoteResult {
  price: number;
  pricedAt: Date;
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

function toFiniteNumber(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  const parsed = Number(raw);
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

export async function fetchGlobalQuote(symbol: string): Promise<QuoteResult | null> {
  if (!env.alphaVantageApiKey) {
    throw new AlphaVantageError(
      'ALPHA_VANTAGE_API_KEY is not configured',
      null,
    );
  }

  const url = new URL('https://www.alphavantage.co/query');
  url.searchParams.set('function', 'GLOBAL_QUOTE');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('apikey', env.alphaVantageApiKey);

  const response = await fetch(url);
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

  const quote = json['Global Quote'] as Record<string, string> | undefined;
  const price = toFiniteNumber(quote?.['05. price']);
  if (price == null) return null;

  const latestDay = quote?.['07. latest trading day'];
  return {
    price,
    pricedAt: latestDay ? new Date(`${latestDay}T21:00:00.000Z`) : new Date(),
  };
}
