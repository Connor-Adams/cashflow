import cron, { type ScheduledTask } from 'node-cron';
import { logger } from '../observability/logger';
import * as env from '../config/env';
import { rebuildForwardProjectionsForAllHouseholds } from './forwardIncomeBuilder';

export interface ForwardIncomeTickResult {
  status: 'skipped_disabled' | 'ran' | 'error';
  householdsProcessed?: number;
  rebuilt?: number;
  deleted?: number;
  error?: string;
}

export interface ForwardIncomeTickConfig {
  enabled: boolean;
}

function configFromEnv(): ForwardIncomeTickConfig {
  return { enabled: env.forwardIncomeEnabled };
}

let runningTick = false;
let activeTask: ScheduledTask | null = null;

export async function runForwardIncomeTick(
  configOverride?: Partial<ForwardIncomeTickConfig>,
): Promise<ForwardIncomeTickResult> {
  const config: ForwardIncomeTickConfig = { ...configFromEnv(), ...configOverride };
  if (!config.enabled) return { status: 'skipped_disabled' };

  try {
    const r = await rebuildForwardProjectionsForAllHouseholds();
    return {
      status: 'ran',
      householdsProcessed: r.households,
      rebuilt: r.rebuilt,
      deleted: r.deleted,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    return { status: 'error', error: msg };
  }
}

export function startForwardIncomeScheduler(): ScheduledTask | null {
  if (!env.forwardIncomeEnabled) {
    logger.info('forward_income_scheduler_disabled');
    return null;
  }
  if (activeTask) {
    logger.warn('forward_income_scheduler_already_running');
    return activeTask;
  }
  if (!cron.validate(env.forwardIncomeCron)) {
    logger.error('forward_income_scheduler_invalid_cron', { expression: env.forwardIncomeCron });
    return null;
  }
  activeTask = cron.schedule(env.forwardIncomeCron, async () => {
    if (runningTick) {
      logger.debug('forward_income_tick_skipped_reentrant');
      return;
    }
    runningTick = true;
    try {
      const r = await runForwardIncomeTick();
      logger.info('forward_income_tick', r as unknown as Record<string, unknown>);
    } catch (err) {
      logger.error('forward_income_tick_unhandled', {}, err);
    } finally {
      runningTick = false;
    }
  });
  logger.info('forward_income_scheduler_started', { cron: env.forwardIncomeCron });
  return activeTask;
}

export function stopForwardIncomeScheduler(): void {
  if (!activeTask) return;
  activeTask.stop();
  activeTask = null;
  runningTick = false;
}
