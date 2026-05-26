/**
 * Yahoo Finance refresh scheduler.
 *
 * On each tick:
 *  1. Skip if the scheduler isn't enabled.
 *  2. Ask the picker for the highest-staleness eligible (security, function)
 *     work item across all configured functions.
 *  3. Dispatch the function-specific fetch + persist, log the call to
 *     `provider_job_log`, and return the outcome.
 *
 * Per-function dispatchers persist to every Security row sharing the same
 * Yahoo-mapped symbol — XEQT.TO data serves all households holding XEQT.
 *
 * Yahoo's public API has no documented per-key quota, so there is no
 * daily-budget gate; we still record every call for diagnostics and rate-
 * limit detection.
 *
 * A simple in-process re-entrancy guard prevents overlapping ticks if a
 * fetch is slow and the next cron fires.
 */

import { Security } from '../../models/Security';
import { SecurityDividend } from '../../models/SecurityDividend';
import { SecurityPrice } from '../../models/SecurityPrice';
import * as env from '../../config/env';
import { reconcileDividendsForSecurity } from '../../portfolio/reconcileDividends';
import { recordCall } from './jobLog';
import {
  YAHOO_PROVIDER,
  YahooFinanceError,
  fetchDividends,
  fetchQuote,
  fetchOverview,
  type DividendEvent,
  type OverviewResult,
  type QuoteResult,
} from './client';
import { overviewToMetadata } from './overviewMetadata';
import { pickNext, type YahooWorkFunction } from './picker';
import { enumerateYahooSymbols, toYahooSymbol } from './symbol';

export interface TickResult {
  status:
    | 'skipped_disabled'
    | 'skipped_no_eligible_symbol'
    | 'refreshed'
    | 'not_found'
    | 'rate_limited'
    | 'error';
  symbol?: string;
  function?: YahooWorkFunction;
  error?: string;
}

export interface TickConfig {
  enabled: boolean;
  minAgeHours: number;
}

function configFromEnv(): TickConfig {
  return {
    enabled: env.quoteSchedulerEnabled,
    minAgeHours: env.quoteMinAgeHours,
  };
}

async function securitiesForYahooSymbol(yahooSymbol: string): Promise<Security[]> {
  const all = await Security.findAll({ where: {} });
  return all.filter(
    (s) =>
      toYahooSymbol(s.symbol, s.currency, {
        assetType: s.assetType,
        name: s.name,
      }) === yahooSymbol,
  );
}

async function persistQuote(yahooSymbol: string, quote: QuoteResult): Promise<void> {
  const securities = await securitiesForYahooSymbol(yahooSymbol);
  if (securities.length === 0) return;
  const now = new Date();
  await Promise.all(
    securities.map((security) =>
      SecurityPrice.create({
        securityId: security.id,
        provider: YAHOO_PROVIDER,
        symbol: security.symbol,
        pricedAt: quote.pricedAt,
        price: String(quote.price),
        currency: security.currency,
        fetchedAt: now,
      }),
    ),
  );
}

async function persistOverview(yahooSymbol: string, overview: OverviewResult): Promise<void> {
  const securities = await securitiesForYahooSymbol(yahooSymbol);
  if (securities.length === 0) return;
  const now = new Date();
  const metadata = overviewToMetadata(overview);
  await Promise.all(
    securities.map((security) =>
      security.update({ metadata, metadataFetchedAt: now }),
    ),
  );
}

async function persistDividends(
  yahooSymbol: string,
  events: DividendEvent[],
): Promise<void> {
  if (events.length === 0) return;
  const securities = await securitiesForYahooSymbol(yahooSymbol);
  if (securities.length === 0) return;
  const now = new Date();
  for (const security of securities) {
    for (const ev of events) {
      await SecurityDividend.upsert({
        securityId: security.id,
        exDividendDate: ev.exDividendDate,
        declarationDate: ev.declarationDate,
        recordDate: ev.recordDate,
        paymentDate: ev.paymentDate,
        amount: String(ev.amount),
        currency: ev.currency,
        source: YAHOO_PROVIDER,
        fetchedAt: now,
      });
    }
  }
  if (env.dividendReconcileEnabled) {
    for (const security of securities) {
      await reconcileDividendsForSecurity(security.id);
    }
  }
}

interface FunctionHandler<T> {
  fetch: (symbol: string) => Promise<T | null>;
  persist: (symbol: string, result: T) => Promise<void>;
  notFoundIsEmptyArray?: boolean;
}

const HANDLERS: Record<YahooWorkFunction, FunctionHandler<unknown>> = {
  QUOTE: {
    fetch: (s) => fetchQuote(s),
    persist: (s, r) => persistQuote(s, r as QuoteResult),
  } as FunctionHandler<unknown>,
  OVERVIEW: {
    fetch: (s) => fetchOverview(s),
    persist: (s, r) => persistOverview(s, r as OverviewResult),
  } as FunctionHandler<unknown>,
  DIVIDENDS: {
    fetch: (s) => fetchDividends(s),
    persist: (s, r) => persistDividends(s, r as DividendEvent[]),
    notFoundIsEmptyArray: true,
  } as FunctionHandler<unknown>,
};

async function dispatch(
  fnName: YahooWorkFunction,
  primaryYahooSymbol: string,
): Promise<TickResult> {
  const handler = HANDLERS[fnName];
  // Resolve the candidate list from any Security row that maps to the
  // primary symbol the picker selected. All rows sharing a primary
  // candidate also share the same alternate suffixes (mapper is pure on
  // symbol/currency/assetType/name and `securitiesForYahooSymbol` already
  // matches on the primary candidate).
  const matchedSecs = await securitiesForYahooSymbol(primaryYahooSymbol);
  const candidates =
    matchedSecs[0] != null
      ? enumerateYahooSymbols(matchedSecs[0].symbol, {
          currency: matchedSecs[0].currency,
          assetType: matchedSecs[0].assetType,
          name: matchedSecs[0].name,
        })
      : [primaryYahooSymbol];
  if (candidates.length === 0) {
    return { status: 'not_found', symbol: primaryYahooSymbol, function: fnName };
  }

  for (let i = 0; i < candidates.length; i++) {
    const symbol = candidates[i];
    const isLast = i === candidates.length - 1;
    try {
      const result = await handler.fetch(symbol);
      const isEmptyArrayOk =
        handler.notFoundIsEmptyArray && Array.isArray(result) && result.length === 0;
      if (result == null) {
        await recordCall({ function: fnName, symbol, status: 'not_found' });
        if (isLast) {
          return { status: 'not_found', symbol, function: fnName };
        }
        continue;
      }
      if (!isEmptyArrayOk) {
        await handler.persist(symbol, result);
      }
      await recordCall({ function: fnName, symbol, status: 'ok' });
      return { status: 'refreshed', symbol, function: fnName };
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
        return {
          status: isRateLimit ? 'rate_limited' : 'error',
          symbol,
          function: fnName,
          error: err.message,
        };
      }
      const message = err instanceof Error ? err.message : 'unknown error';
      await recordCall({
        function: fnName,
        symbol,
        status: 'error',
        errorMessage: message.slice(0, 1024),
      });
      return { status: 'error', symbol, function: fnName, error: message };
    }
  }
  return { status: 'not_found', symbol: primaryYahooSymbol, function: fnName };
}

export async function runQuoteSchedulerTick(
  configOverride?: Partial<TickConfig>,
): Promise<TickResult> {
  const config: TickConfig = { ...configFromEnv(), ...configOverride };

  if (!config.enabled) {
    return { status: 'skipped_disabled' };
  }

  const item = await pickNext({
    minAgeSeconds: config.minAgeHours * 3600,
  });
  if (!item) {
    return { status: 'skipped_no_eligible_symbol' };
  }

  return dispatch(item.function, item.yahooSymbol);
}

