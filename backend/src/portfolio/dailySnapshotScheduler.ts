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
