export type JobStatus =
  | 'ok'
  | 'error'
  | 'skipped_disabled'
  | 'skipped_locked'
  | 'skipped_reentrant';

export interface JobRunView {
  id: number;
  jobName: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'success' | 'failed' | 'skipped';
  durationMs: number | null;
  errorMessage: string | null;
}

export interface JobHandlerResult {
  /** Optional structured summary persisted as JSON (truncated to 2KB). */
  summary?: Record<string, unknown>;
}

export type JobHandler = () => Promise<JobHandlerResult | void>;

export interface JobDefinition {
  name: string;
  cronDefault: string;
  enabledDefault: boolean;
  handler: JobHandler;
}

export interface ResolvedJobConfig {
  enabled: boolean;
  cron: string;
  source: {
    enabled: 'env' | 'db';
    cron: 'env' | 'db';
  };
}

export interface JobStatusView {
  name: string;
  cron: string;
  enabled: boolean;
  source: ResolvedJobConfig['source'];
  lastRunAt: string | null;
  lastFinishedAt: string | null;
  lastStatus: JobStatus | null;
  lastDurationMs: number | null;
  lastError: string | null;
  lastResultJson: string | null;
  nextRunAt: string | null;
}
