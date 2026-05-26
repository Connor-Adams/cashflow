import cron, { type ScheduledTask } from 'node-cron';
import { CronExpressionParser } from 'cron-parser';
import { Job } from '../models';
import { logger } from '../observability/logger';
import { resolveJobConfig } from './configResolver';
import { tick, type TickOutcome } from './runner';
import type { JobDefinition, JobStatusView } from './types';

const definitions = new Map<string, JobDefinition>();
const scheduled = new Map<string, { task: ScheduledTask; cron: string; enabled: boolean }>();
let reconcileTimer: NodeJS.Timeout | null = null;

export function defineJob(def: JobDefinition): void {
  if (definitions.has(def.name)) {
    throw new Error(`Job already defined: ${def.name}`);
  }
  if (!cron.validate(def.cronDefault)) {
    throw new Error(`Invalid cronDefault for job ${def.name}: ${def.cronDefault}`);
  }
  definitions.set(def.name, def);
}

export function listDefinitions(): JobDefinition[] {
  return Array.from(definitions.values());
}

function nextRunAt(cronExpr: string): string | null {
  try {
    return CronExpressionParser.parse(cronExpr).next().toISOString();
  } catch {
    return null;
  }
}

export async function listJobs(): Promise<JobStatusView[]> {
  const out: JobStatusView[] = [];
  for (const def of definitions.values()) {
    const cfg = await resolveJobConfig(def);
    const row = await Job.findOne({ where: { name: def.name } });
    out.push({
      name: def.name,
      cron: cfg.cron,
      enabled: cfg.enabled,
      source: cfg.source,
      lastRunAt: row?.lastRunAt ? row.lastRunAt.toISOString() : null,
      lastFinishedAt: row?.lastFinishedAt ? row.lastFinishedAt.toISOString() : null,
      lastStatus: (row?.lastStatus as JobStatusView['lastStatus']) ?? null,
      lastDurationMs: row?.lastDurationMs ?? null,
      lastError: row?.lastError ?? null,
      lastResultJson: row?.lastResultJson ?? null,
      nextRunAt: cfg.enabled ? nextRunAt(cfg.cron) : null,
    });
  }
  return out;
}

export async function runJobByName(name: string): Promise<TickOutcome> {
  const def = definitions.get(name);
  if (!def) throw new Error(`unknown job: ${name}`);
  return tick(def);
}

async function applyConfig(def: JobDefinition): Promise<void> {
  const cfg = await resolveJobConfig(def);
  const current = scheduled.get(def.name);
  const needsRebuild =
    !current ||
    current.cron !== cfg.cron ||
    current.enabled !== cfg.enabled;
  if (!needsRebuild) return;

  if (current) {
    current.task.stop();
    scheduled.delete(def.name);
  }
  if (!cfg.enabled) {
    logger.info({ name: def.name, cron: cfg.cron }, 'job_disabled');
    return;
  }
  if (!cron.validate(cfg.cron)) {
    logger.error({ name: def.name, cron: cfg.cron }, 'job_reconcile_invalid_cron');
    return;
  }
  const task = cron.schedule(cfg.cron, async () => {
    await tick(def);
  });
  scheduled.set(def.name, { task, cron: cfg.cron, enabled: cfg.enabled });
  logger.info({ name: def.name, cron: cfg.cron }, 'job_scheduled');
}

export async function reconcileOnceForTest(): Promise<void> {
  for (const def of definitions.values()) {
    await applyConfig(def);
  }
}

export interface StartOptions {
  /** Reconcile interval in ms. Pass null to disable the timer (tests). */
  reconcileMs?: number | null;
}

export async function startAllJobs(opts: StartOptions = {}): Promise<void> {
  for (const def of definitions.values()) {
    await applyConfig(def);
  }
  const ms = opts.reconcileMs === undefined ? 60_000 : opts.reconcileMs;
  if (ms !== null) {
    reconcileTimer = setInterval(() => {
      void (async () => {
        for (const def of definitions.values()) {
          try {
            await applyConfig(def);
          } catch (err) {
            logger.error({ err, name: def.name }, 'job_reconcile_failed');
          }
        }
      })();
    }, ms);
    reconcileTimer.unref?.();
  }
}

export function stopAllJobs(): void {
  for (const [, s] of scheduled) s.task.stop();
  scheduled.clear();
  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    reconcileTimer = null;
  }
}

export function __resetForTest(): void {
  stopAllJobs();
  definitions.clear();
}
