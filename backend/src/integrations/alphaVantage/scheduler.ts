/**
 * Quote refresh scheduler.
 *
 * On each tick:
 *  1. Skip if Alpha Vantage isn't configured.
 *  2. Bail if today's call budget is already spent.
 *  3. Ask the picker for the staleness-oldest eligible symbol.
 *  4. Fetch the GLOBAL_QUOTE, log the call, and persist a SecurityPrice row
 *     for every Security holding that symbol (symbols are global across
 *     households).
 *
 * A simple in-process re-entrancy guard prevents overlapping ticks if a fetch
 * is slow and the next cron fires.
 */

import cron, { type ScheduledTask } from 'node-cron';
import { Security } from '../../models/Security';
import { SecurityPrice } from '../../models/SecurityPrice';
import { logger } from '../../observability/logger';
import * as env from '../../config/env';
import {
  AlphaVantageError,
  fetchGlobalQuote,
  type QuoteResult,
} from './client';
import { checkBudget, recordCall } from './budget';
import { pickNext } from './picker';

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

async function persistQuoteForSymbol(symbol: string, quote: QuoteResult): Promise<void> {
  const securities = await Security.findAll({ where: { symbol } });
  if (securities.length === 0) return;
  const now = new Date();
  await Promise.all(
    securities.map((security) =>
      SecurityPrice.create({
        securityId: security.id,
        provider: 'alpha_vantage',
        symbol: security.symbol,
        pricedAt: quote.pricedAt,
        price: String(quote.price),
        currency: security.currency,
        fetchedAt: now,
      }),
    ),
  );
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
    return { status: 'skipped_no_eligible_symbol', budget: { used: budget.used, limit: budget.limit } };
  }

  try {
    const quote = await fetchGlobalQuote(item.symbol);
    if (!quote) {
      await recordCall({ function: item.function, symbol: item.symbol, status: 'not_found' });
      return { status: 'not_found', symbol: item.symbol };
    }
    await persistQuoteForSymbol(item.symbol, quote);
    await recordCall({ function: item.function, symbol: item.symbol, status: 'ok' });
    return { status: 'refreshed', symbol: item.symbol };
  } catch (err) {
    if (err instanceof AlphaVantageError) {
      const isRateLimit = err.providerNote != null;
      await recordCall({
        function: item.function,
        symbol: item.symbol,
        status: isRateLimit ? 'rate_limited' : 'error',
        httpStatus: err.httpStatus,
        errorMessage: err.message.slice(0, 1024),
      });
      return {
        status: isRateLimit ? 'rate_limited' : 'error',
        symbol: item.symbol,
        error: err.message,
      };
    }
    const message = err instanceof Error ? err.message : 'unknown error';
    await recordCall({
      function: item.function,
      symbol: item.symbol,
      status: 'error',
      errorMessage: message.slice(0, 1024),
    });
    return { status: 'error', symbol: item.symbol, error: message };
  }
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
