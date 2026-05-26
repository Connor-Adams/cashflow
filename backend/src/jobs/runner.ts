import { randomUUID } from 'node:crypto';
import { Job, JobRun } from '../models';
import { enqueueNotification } from '../notifications';
import { logger } from '../observability/logger';
import { withContext } from '../observability/requestContext';
import { resolveJobConfig } from './configResolver';
import { withAdvisoryLock } from './pgLock';
import { pruneJobRuns } from './runRetention';
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
    logger.error({ err, name }, 'job_state_persist_failed');
  }
}

export interface TickOutcome {
  status: JobStatus;
  durationMs: number;
  jobName: string;
  runId?: number;
  queuedAt?: string;
  result?: Record<string, unknown>;
  error?: string;
}

export interface TickOptions {
  failureNotificationUserIds?: number[];
}

export async function tick(def: JobDefinition, opts: TickOptions = {}): Promise<TickOutcome> {
  return withContext({ jobName: def.name, tickId: randomUUID() }, () => tickInner(def, opts));
}

async function createRun(jobName: string, startedAt: Date): Promise<JobRun | null> {
  try {
    return await JobRun.create({
      jobName,
      startedAt,
      finishedAt: null,
      status: 'running',
      durationMs: null,
      errorMessage: null,
    });
  } catch (err) {
    logger.error({ err, name: jobName }, 'job_run_create_failed');
    return null;
  }
}

async function finishRun(
  run: JobRun | null,
  patch: { status: 'success' | 'failed' | 'skipped'; durationMs: number; errorMessage?: string | null },
): Promise<void> {
  if (!run) return;
  try {
    await run.update({
      finishedAt: new Date(),
      status: patch.status,
      durationMs: patch.durationMs,
      errorMessage: patch.errorMessage ?? null,
    });
  } catch (err) {
    logger.error({ err, runId: run.id, name: run.jobName }, 'job_run_update_failed');
  }
}

async function pruneRuns(jobName: string, keep = 100): Promise<void> {
  try {
    await pruneJobRuns(jobName, keep);
  } catch (err) {
    logger.error({ err, name: jobName }, 'job_run_prune_failed');
  }
}

async function notifyFailure(
  def: JobDefinition,
  run: JobRun | null,
  message: string,
  userIds: number[] | undefined,
): Promise<void> {
  if (!run || !userIds?.length) return;
  await Promise.all(userIds.map(async (userId) => {
    try {
      await enqueueNotification(userId, 'job.failed', {
        severity: 'critical',
        title: `${def.name} failed`,
        body: message,
        dataJson: { jobName: def.name, runId: run.id },
      });
    } catch (err) {
      logger.error({ err, name: def.name, userId, runId: run.id }, 'job_failure_notification_failed');
    }
  }));
}

async function tickInner(def: JobDefinition, opts: TickOptions): Promise<TickOutcome> {
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
    return { status: 'skipped_disabled', durationMs: 0, jobName: def.name };
  }

  if (runningTicks.has(def.name)) {
    await upsertState(def.name, {
      lastRunAt: startedAt,
      lastFinishedAt: startedAt,
      lastStatus: 'skipped_reentrant',
      lastDurationMs: 0,
      lastError: null,
    });
    return { status: 'skipped_reentrant', durationMs: 0, jobName: def.name };
  }
  runningTicks.add(def.name);
  await upsertState(def.name, { lastRunAt: startedAt });
  const run = await createRun(def.name, startedAt);
  const runMeta = {
    jobName: def.name,
    runId: run?.id,
    queuedAt: startedAt.toISOString(),
  };

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
      await finishRun(run, { status: 'skipped', durationMs });
      await pruneRuns(def.name);
      return { status: 'skipped_locked', durationMs, ...runMeta };
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
    await finishRun(run, { status: 'success', durationMs });
    await pruneRuns(def.name);
    logger.info({ name: def.name, durationMs }, 'job_tick_ok');
    return { status: 'ok', durationMs, result: summary, ...runMeta };
  } catch (err) {
    const durationMs = Date.now() - t0;
    const message = err instanceof Error ? err.message : String(err);
    await upsertState(def.name, {
      lastFinishedAt: new Date(),
      lastStatus: 'error',
      lastDurationMs: durationMs,
      lastError: truncate(message, ERROR_MAX),
    });
    const truncated = truncate(message, ERROR_MAX);
    await finishRun(run, { status: 'failed', durationMs, errorMessage: truncated });
    await notifyFailure(def, run, truncated, opts.failureNotificationUserIds);
    await pruneRuns(def.name);
    logger.error({ err, name: def.name, durationMs }, 'job_tick_failed');
    return { status: 'error', durationMs, error: message, ...runMeta };
  } finally {
    runningTicks.delete(def.name);
  }
}

export function isTickRunning(name: string): boolean {
  return runningTicks.has(name);
}
