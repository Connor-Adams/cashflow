export type JobStatus =
  | 'ok'
  | 'error'
  | 'skipped_disabled'
  | 'skipped_locked'
  | 'skipped_reentrant'

export type JobRunStatus = 'running' | 'success' | 'failed' | 'skipped'

export interface JobView {
  name: string
  cron: string
  enabled: boolean
  source: { enabled: 'env' | 'db'; cron: 'env' | 'db' }
  lastRunAt: string | null
  lastFinishedAt: string | null
  lastStatus: JobStatus | null
  lastDurationMs: number | null
  lastError: string | null
  lastResultJson: string | null
  nextRunAt: string | null
}

export interface JobRunOutcome {
  status: JobStatus
  durationMs: number
  jobName: string
  runId?: number
  queuedAt?: string
  result?: Record<string, unknown>
  error?: string
}

export interface JobRunView {
  id: number
  jobName: string
  startedAt: string
  finishedAt: string | null
  status: JobRunStatus
  durationMs: number | null
  errorMessage: string | null
}
