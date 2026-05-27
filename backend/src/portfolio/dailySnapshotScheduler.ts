import { trace } from '@opentelemetry/api';
import * as env from '../config/env';
import { buildDailySnapshotsForAllHouseholds } from './dailySnapshotBuilder';

const tracer = trace.getTracer('cashflow-scheduler');

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

export async function runDailySnapshotTick(
  configOverride?: Partial<DailySnapshotTickConfig>,
): Promise<DailySnapshotTickResult> {
  return tracer.startActiveSpan('daily_snapshot_scheduler.tick', async (span): Promise<DailySnapshotTickResult> => {
    try {
      const config: DailySnapshotTickConfig = { ...configFromEnv(), ...configOverride };
      if (!config.enabled) return { status: 'skipped_disabled' };

      const r = await buildDailySnapshotsForAllHouseholds();
      return {
        status: 'ran',
        householdsProcessed: r.households,
        daysBuilt: r.daysBuilt,
        daysSkipped: r.daysSkipped,
        partialDays: r.partialDays,
      };
    } catch (err) {
      span.recordException(err as Error);
      throw err;
    } finally {
      span.end();
    }
  });
}
