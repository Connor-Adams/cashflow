import { Job } from '../models';
import { logger } from '../observability/logger';
import { resolveJobConfig } from './configResolver';
import { withAdvisoryLock } from './pgLock';
import type { JobDefinition, JobStatus } from './types';

const runningTicks = new Set<string>();

const ERROR_MAX = 1024;
const RESULT_MAX = 2048;

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max);
}

async function upsertState(
  name: string,
  patch: Partial<{
    lastRunAt: Date;
    lastFinishedAt: Date;
    lastStatus: JobStatus;
    lastDurationMs: number;
    lastError: string | null;
    lastResultJson: string | null;
  }>,
): Promise<void> {
  try {
    const [row] = await Job.findOrCreate({
      where: { name },
      defaults: {
        name,
        enabledOverride: null,
        cronOverride: null,
        lastRunAt: null,
        lastFinishedAt: null,
        lastStatus: null,
        lastDurationMs: null,
        lastError: null,
        lastResultJson: null,
      },
    });
    await row.update(patch);
  } catch (err) {
    logger.error('job_state_persist_failed', { name }, err as Error);
  }
}

export interface TickOutcome {
  status: JobStatus;
  durationMs: number;
  result?: Record<string, unknown>;
  error?: string;
}

export async function tick(def: JobDefinition): Promise<TickOutcome> {
  const startedAt = new Date();
  const cfg = await resolveJobConfig(def);
  if (!cfg.enabled) {
    await upsertState(def.name, {
      lastRunAt: startedAt,
      lastFinishedAt: startedAt,
      lastStatus: 'skipped_disabled',
      lastDurationMs: 0,
      lastError: null,
    });
    return { status: 'skipped_disabled', durationMs: 0 };
  }

  if (runningTicks.has(def.name)) {
    await upsertState(def.name, {
      lastRunAt: startedAt,
      lastFinishedAt: startedAt,
      lastStatus: 'skipped_reentrant',
      lastDurationMs: 0,
      lastError: null,
    });
    return { status: 'skipped_reentrant', durationMs: 0 };
  }
  runningTicks.add(def.name);
  await upsertState(def.name, { lastRunAt: startedAt });

  const t0 = Date.now();
  try {
    const lockResult = await withAdvisoryLock(def.name, () => def.handler());
    const durationMs = Date.now() - t0;
    if (!lockResult.acquired) {
      await upsertState(def.name, {
        lastFinishedAt: new Date(),
        lastStatus: 'skipped_locked',
        lastDurationMs: durationMs,
        lastError: null,
      });
      return { status: 'skipped_locked', durationMs };
    }
    const handlerResult = lockResult.value;
    const summary =
      handlerResult && typeof handlerResult === 'object' && 'summary' in handlerResult
        ? (handlerResult as { summary?: Record<string, unknown> }).summary
        : undefined;
    const lastResultJson = summary
      ? truncate(JSON.stringify(summary), RESULT_MAX)
      : null;
    await upsertState(def.name, {
      lastFinishedAt: new Date(),
      lastStatus: 'ok',
      lastDurationMs: durationMs,
      lastError: null,
      lastResultJson,
    });
    logger.info('job_tick_ok', { name: def.name, durationMs });
    return { status: 'ok', durationMs, result: summary };
  } catch (err) {
    const durationMs = Date.now() - t0;
    const message = err instanceof Error ? err.message : String(err);
    await upsertState(def.name, {
      lastFinishedAt: new Date(),
      lastStatus: 'error',
      lastDurationMs: durationMs,
      lastError: truncate(message, ERROR_MAX),
    });
    logger.error('job_tick_failed', { name: def.name, durationMs }, err as Error);
    return { status: 'error', durationMs, error: message };
  } finally {
    runningTicks.delete(def.name);
  }
}

export function isTickRunning(name: string): boolean {
  return runningTicks.has(name);
}
