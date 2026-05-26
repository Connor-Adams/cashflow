import cron, { type ScheduledTask } from 'node-cron';
import { randomUUID } from 'crypto';
import { logger } from '../observability/logger';
import { withContext } from '../observability/requestContext';
import * as env from '../config/env';
import { buildDailySnapshotsForAllHouseholds } from './dailySnapshotBuilder';

export interface DailySnapshotTickResult {
  status: 'skipped_disabled' | 'ran' | 'error';
  householdsProcessed?: number;
  daysBuilt?: number;
  daysSkipped?: number;
  partialDays?: number;
  error?: string;
}

export interface DailySnapshotTickConfig {
  enabled: boolean;
}

function configFromEnv(): DailySnapshotTickConfig {
  return { enabled: env.dailySnapshotEnabled };
}

let runningTick = false;
let activeTask: ScheduledTask | null = null;

export async function runDailySnapshotTick(
  configOverride?: Partial<DailySnapshotTickConfig>,
): Promise<DailySnapshotTickResult> {
  const config: DailySnapshotTickConfig = { ...configFromEnv(), ...configOverride };
  if (!config.enabled) return { status: 'skipped_disabled' };

  try {
    const r = await buildDailySnapshotsForAllHouseholds();
    return {
      status: 'ran',
      householdsProcessed: r.households,
      daysBuilt: r.daysBuilt,
      daysSkipped: r.daysSkipped,
      partialDays: r.partialDays,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    return { status: 'error', error: msg };
  }
}

export function startDailySnapshotScheduler(): ScheduledTask | null {
  if (!env.dailySnapshotEnabled) {
    logger.info({}, 'daily_snapshot_scheduler_disabled');
    return null;
  }
  if (activeTask) {
    logger.warn({}, 'daily_snapshot_scheduler_already_running');
    return activeTask;
  }
  if (!cron.validate(env.dailySnapshotCron)) {
    logger.error({ expression: env.dailySnapshotCron }, 'daily_snapshot_scheduler_invalid_cron');
    return null;
  }
  activeTask = cron.schedule(env.dailySnapshotCron, async () => {
    await withContext(
      { jobName: 'daily_snapshot_scheduler', tickId: randomUUID() },
      async () => {
        if (runningTick) {
          logger.debug({}, 'daily_snapshot_tick_skipped_reentrant');
          return;
        }
        runningTick = true;
        try {
          const r = await runDailySnapshotTick();
          logger.info(r as unknown as Record<string, unknown>, 'daily_snapshot_tick');
        } catch (err) {
          logger.error({ err }, 'daily_snapshot_tick_unhandled');
        } finally {
          runningTick = false;
        }
      },
    );
  });
  logger.info({ cron: env.dailySnapshotCron }, 'daily_snapshot_scheduler_started');
  return activeTask;
}

export function stopDailySnapshotScheduler(): void {
  if (!activeTask) return;
  activeTask.stop();
  activeTask = null;
  runningTick = false;
}
