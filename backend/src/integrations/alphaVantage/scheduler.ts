/**
 * Alpha Vantage refresh scheduler.
 *
 * On each tick:
 *  1. Skip if Alpha Vantage isn't configured.
 *  2. Bail if today's shared call budget is already spent.
 *  3. Ask the picker for the highest-staleness eligible (symbol, function)
 *     work item across all configured functions.
 *  4. Dispatch the function-specific fetch + persist, log the call to
 *     `provider_job_log`, and return the outcome.
 *
 * Per-function dispatchers persist to every Security row holding the
 * symbol — the same AAPL fundamentals serve all households.
 *
 * A simple in-process re-entrancy guard prevents overlapping ticks if a
 * fetch is slow and the next cron fires.
 */

import cron, { type ScheduledTask } from 'node-cron';
import { Security } from '../../models/Security';
import { SecurityDividend } from '../../models/SecurityDividend';
import { SecurityPrice } from '../../models/SecurityPrice';
import { logger } from '../../observability/logger';
import * as env from '../../config/env';
import { reconcileDividendsForSecurity } from '../../portfolio/reconcileDividends';
import {
  ALPHA_VANTAGE_PROVIDER,
  checkBudget,
  recordCall,
} from './budget';
import {
  AlphaVantageError,
  fetchDividends,
  fetchGlobalQuote,
  fetchOverview,
  type DividendEvent,
  type OverviewResult,
  type QuoteResult,
} from './client';
import { pickNext, type AvWorkFunction } from './picker';

export interface TickResult {
  status:
    | 'skipped_disabled'
    | 'skipped_no_api_key'
    | 'skipped_budget_exhausted'
    | 'skipped_no_eligible_symbol'
    | 'refreshed'
    | 'not_found'
    | 'rate_limited'
    | 'error';
  symbol?: string;
  function?: AvWorkFunction;
  budget?: { used: number; limit: number };
  error?: string;
}

export interface TickConfig {
  enabled: boolean;
  apiKey: string | null;
  dailyBudget: number;
  minAgeHours: number;
}

function configFromEnv(): TickConfig {
  return {
    enabled: env.quoteSchedulerEnabled,
    apiKey: env.alphaVantageApiKey,
    dailyBudget: env.quoteDailyBudget,
    minAgeHours: env.quoteMinAgeHours,
  };
}

let runningTick = false;

async function securitiesForSymbol(symbol: string): Promise<Security[]> {
  return Security.findAll({ where: { symbol } });
}

async function persistGlobalQuote(symbol: string, quote: QuoteResult): Promise<void> {
  const securities = await securitiesForSymbol(symbol);
  if (securities.length === 0) return;
  const now = new Date();
  await Promise.all(
    securities.map((security) =>
      SecurityPrice.create({
        securityId: security.id,
        provider: ALPHA_VANTAGE_PROVIDER,
        symbol: security.symbol,
        pricedAt: quote.pricedAt,
        price: String(quote.price),
        currency: security.currency,
        fetchedAt: now,
      }),
    ),
  );
}

async function persistOverview(symbol: string, overview: OverviewResult): Promise<void> {
  const securities = await securitiesForSymbol(symbol);
  if (securities.length === 0) return;
  const now = new Date();
  const metadata = {
    sector: overview.sector,
    industry: overview.industry,
    country: overview.country,
    exchange: overview.exchange,
    description: overview.description,
    ...overview.raw,
  };
  await Promise.all(
    securities.map((security) =>
      security.update({ metadata, metadataFetchedAt: now }),
    ),
  );
}

async function persistDividends(symbol: string, events: DividendEvent[]): Promise<void> {
  if (events.length === 0) return;
  const securities = await securitiesForSymbol(symbol);
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
        source: ALPHA_VANTAGE_PROVIDER,
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

const HANDLERS: Record<AvWorkFunction, FunctionHandler<unknown>> = {
  GLOBAL_QUOTE: {
    fetch: (s) => fetchGlobalQuote(s),
    persist: (s, r) => persistGlobalQuote(s, r as QuoteResult),
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
  fnName: AvWorkFunction,
  symbol: string,
): Promise<TickResult> {
  const handler = HANDLERS[fnName];
  try {
    const result = await handler.fetch(symbol);
    // DIVIDENDS returns an empty array (not null) for symbols with no
    // payout history — treat that as `ok` so we don't keep retrying it.
    const isEmptyArrayOk =
      handler.notFoundIsEmptyArray && Array.isArray(result) && result.length === 0;
    if (result == null) {
      await recordCall({ function: fnName, symbol, status: 'not_found' });
      return { status: 'not_found', symbol, function: fnName };
    }
    if (!isEmptyArrayOk) {
      await handler.persist(symbol, result);
    }
    await recordCall({ function: fnName, symbol, status: 'ok' });
    return { status: 'refreshed', symbol, function: fnName };
  } catch (err) {
    if (err instanceof AlphaVantageError) {
      const isRateLimit = err.providerNote != null;
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

export async function runQuoteSchedulerTick(
  configOverride?: Partial<TickConfig>,
): Promise<TickResult> {
  const config: TickConfig = { ...configFromEnv(), ...configOverride };

  if (!config.enabled) {
    return { status: 'skipped_disabled' };
  }
  if (!config.apiKey) {
    return { status: 'skipped_no_api_key' };
  }

  const budget = await checkBudget(config.dailyBudget);
  if (!budget.ok) {
    return {
      status: 'skipped_budget_exhausted',
      budget: { used: budget.used, limit: budget.limit },
    };
  }

  const item = await pickNext({
    minAgeSeconds: config.minAgeHours * 3600,
  });
  if (!item) {
    return {
      status: 'skipped_no_eligible_symbol',
      budget: { used: budget.used, limit: budget.limit },
    };
  }

  return dispatch(item.function, item.symbol);
}

let activeTask: ScheduledTask | null = null;

export function startQuoteScheduler(): ScheduledTask | null {
  if (!env.quoteSchedulerEnabled) {
    logger.info('quote_scheduler_disabled', {
      reason: env.alphaVantageApiKey ? 'flag_off' : 'no_api_key',
    });
    return null;
  }
  if (activeTask) {
    logger.warn('quote_scheduler_already_running');
    return activeTask;
  }
  if (!cron.validate(env.quoteTickCron)) {
    logger.error('quote_scheduler_invalid_cron', { expression: env.quoteTickCron });
    return null;
  }

  activeTask = cron.schedule(env.quoteTickCron, async () => {
    if (runningTick) {
      logger.debug('quote_scheduler_tick_skipped_reentrant');
      return;
    }
    runningTick = true;
    try {
      const result = await runQuoteSchedulerTick();
      logger.info('quote_scheduler_tick', result as unknown as Record<string, unknown>);
    } catch (err) {
      logger.error('quote_scheduler_tick_unhandled', {}, err);
    } finally {
      runningTick = false;
    }
  });

  logger.info('quote_scheduler_started', {
    cron: env.quoteTickCron,
    dailyBudget: env.quoteDailyBudget,
    minAgeHours: env.quoteMinAgeHours,
  });
  return activeTask;
}

export function stopQuoteScheduler(): void {
  if (!activeTask) return;
  activeTask.stop();
  activeTask = null;
}
