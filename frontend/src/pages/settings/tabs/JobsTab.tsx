import { Fragment, useCallback, useEffect, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { Button, Icon } from '@connor-adams/designsystem'
import { useToast } from '@/components/ui/toast'
import { cn } from '@/lib/utils'
import { describeCron } from '@/lib/cron'
import { getJson, patchJson, postJson } from '../../../lib/api'
import type { JobRunOutcome, JobRunView, JobView } from '../../../types/jobs'

const TH = 'px-3 py-2 text-left text-xs font-medium uppercase tracking-wide'
const TD = 'px-3 py-2 align-middle'

function formatRelative(iso: string | null): string {
  if (!iso) return 'Never run'
  const d = new Date(iso)
  const diffMs = Date.now() - d.getTime()
  if (diffMs < 60_000) return 'just now'
  const mins = Math.round(diffMs / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.round(hrs / 24)
  return `${days}d ago`
}

function formatRelativeFuture(iso: string | null): string {
  if (!iso) return '-'
  const diffMs = new Date(iso).getTime() - Date.now()
  if (diffMs <= 0) return 'due'
  const mins = Math.round(diffMs / 60_000)
  if (mins < 1) return 'in <1m'
  if (mins < 60) return `in ${mins}m`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `in ${hrs}h`
  const days = Math.round(hrs / 24)
  return `in ${days}d`
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '-'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)}s`
}

function truncatedError(message: string): string {
  return message.length <= 96 ? message : `${message.slice(0, 93)}...`
}

function jobStatus(job: JobView, running: boolean) {
  if (running) return { label: 'Running', className: 'bg-info-bg text-info' }
  switch (job.lastStatus) {
    case 'ok':
      return { label: 'Success', className: 'bg-success-bg text-positive' }
    case 'error':
      return { label: 'Failure', className: 'bg-danger-bg text-danger' }
    case 'skipped_disabled':
    case 'skipped_locked':
    case 'skipped_reentrant':
      return { label: 'Success', className: 'bg-success-bg text-positive' }
    default:
      return { label: 'Never run', className: 'bg-muted text-muted-foreground' }
  }
}

function runStatus(run: JobRunView) {
  switch (run.status) {
    case 'success':
      return { label: 'Success', className: 'bg-success-bg text-positive' }
    case 'failed':
      return { label: 'Failure', className: 'bg-danger-bg text-danger' }
    case 'running':
      return { label: 'Running', className: 'bg-info-bg text-info' }
    default:
      return { label: 'Skipped', className: 'bg-muted text-muted-foreground' }
  }
}

function StatusPill({ label, className }: { label: string; className: string }) {
  return (
    <span className={cn('inline-flex rounded-full px-2 py-0.5 text-xs font-semibold', className)}>
      {label}
    </span>
  )
}

export function JobsTab() {
  const toast = useToast()
  const [jobs, setJobs] = useState<JobView[]>([])
  const [runs, setRuns] = useState<Record<string, JobRunView[]>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [autoRefresh, setAutoRefresh] = useState(true)

  const loadRuns = useCallback(async (name: string) => {
    const rows = await getJson<JobRunView[]>(`/api/jobs/${name}/runs?limit=10`)
    setRuns((current) => ({ ...current, [name]: rows }))
  }, [])

  const load = useCallback(async () => {
    try {
      const nextJobs = await getJson<JobView[]>('/api/jobs')
      setJobs(nextJobs)
      await Promise.all(
        nextJobs
          .filter((job) => expanded[job.name])
          .map((job) => loadRuns(job.name))
      )
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load jobs')
    } finally {
      setLoading(false)
    }
  }, [expanded, loadRuns])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!autoRefresh) return
    const id = window.setInterval(() => {
      void load()
    }, 10_000)
    return () => window.clearInterval(id)
  }, [autoRefresh, load])

  const toggleExpanded = async (job: JobView) => {
    const nextExpanded = !expanded[job.name]
    setExpanded((current) => ({ ...current, [job.name]: nextExpanded }))
    if (nextExpanded) {
      try {
        await loadRuns(job.name)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not load job runs')
      }
    }
  }

  const toggleEnabled = async (job: JobView) => {
    setBusy((b) => ({ ...b, [job.name]: true }))
    try {
      const updated = await patchJson<JobView>(`/api/jobs/${job.name}`, {
        enabled: !job.enabled,
      })
      setJobs((js) => js.map((j) => (j.name === job.name ? updated : j)))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Toggle failed')
    } finally {
      setBusy((b) => ({ ...b, [job.name]: false }))
    }
  }

  const runNow = async (job: JobView) => {
    setBusy((b) => ({ ...b, [job.name]: true }))
    setJobs((js) => js.map((j) => (
      j.name === job.name ? { ...j, lastStatus: 'ok', lastRunAt: new Date().toISOString() } : j
    )))
    toast.showToast({ title: `Started ${job.name}.` })
    try {
      const outcome = await postJson<JobRunOutcome>(`/api/jobs/${job.name}/run`)
      if (outcome.status === 'error') {
        toast.showToast({
          title: `${job.name} failed: ${truncatedError(outcome.error ?? 'Unknown error')}`,
          variant: 'destructive',
        })
      } else {
        toast.showToast({
          title: `${job.name} finished in ${formatDuration(outcome.durationMs)}`,
          variant: 'success',
        })
      }
      await load()
      if (expanded[job.name]) await loadRuns(job.name)
    } catch (e) {
      toast.showToast({
        title: `${job.name} failed: ${truncatedError(e instanceof Error ? e.message : 'Run failed')}`,
        variant: 'destructive',
      })
      setError(e instanceof Error ? e.message : 'Run failed')
    } finally {
      setBusy((b) => ({ ...b, [job.name]: false }))
    }
  }

  const resetOverrides = async (job: JobView) => {
    setBusy((b) => ({ ...b, [job.name]: true }))
    try {
      const updated = await patchJson<JobView>(`/api/jobs/${job.name}`, {
        enabled: null,
        cron: null,
      })
      setJobs((js) => js.map((j) => (j.name === job.name ? updated : j)))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reset failed')
    } finally {
      setBusy((b) => ({ ...b, [job.name]: false }))
    }
  }

  return (
    <div className="jobsTabRoot space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Scheduled jobs</h2>
        <Button
          type="button"
          variant="outline"
          size="sm"
          role="switch"
          aria-checked={autoRefresh}
          aria-label="Auto-refresh"
          onClick={() => setAutoRefresh((v) => !v)}
        >
          <span className={cn('h-2 w-2 rounded-full', autoRefresh ? 'bg-positive' : 'bg-muted-foreground/40')} />
          Auto-refresh
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-danger bg-danger-bg px-3 py-2 text-sm text-danger" role="alert">
          {error}
          <Button type="button" size="sm" variant="ghost" className="ml-2" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      )}

      {loading ? (
        <div className="rounded-md border border-border p-4 text-sm text-muted-foreground">Loading scheduled jobs...</div>
      ) : jobs.length === 0 ? (
        <div className="rounded-md border border-border p-4 text-sm text-muted-foreground">No scheduled jobs found.</div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className={TH}>Job</th>
                <th className={TH}>Schedule</th>
                <th className={TH}>Enabled</th>
                <th className={TH}>Last run</th>
                <th className={TH}>Next run</th>
                <th className={cn(TH, 'text-right')}>Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {jobs.map((j) => {
                const isExpanded = Boolean(expanded[j.name])
                const isRunning = Boolean(busy[j.name])
                const status = jobStatus(j, isRunning)
                const hasCron = Boolean(j.cron) && j.cron !== 'manual'
                const noOverrides = j.source.enabled === 'env' && j.source.cron === 'env'
                return (
                  <Fragment key={j.name}>
                    <tr className="hover:bg-muted/30">
                      <td className={TD}>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={`${isExpanded ? 'Hide' : 'Show'} runs for ${j.name}`}
                          onClick={() => void toggleExpanded(j)}
                          className="font-medium"
                        >
                          {isExpanded ? <Icon name="chevron-down" size={16} /> : <Icon name="chevron-right" size={16} />}
                          {j.name}
                        </Button>
                      </td>
                      <td className={TD}>
                        <span
                          title={hasCron ? j.cron : undefined}
                          className={cn(hasCron && 'cursor-help underline decoration-dotted decoration-muted-foreground/40 underline-offset-4')}
                        >
                          {describeCron(j.cron)}
                        </span>
                      </td>
                      <td className={TD}>
                        <Button
                          role="switch"
                          variant="ghost"
                          size="sm"
                          aria-checked={j.enabled}
                          aria-label={`${j.name} enabled`}
                          disabled={isRunning}
                          onClick={() => void toggleEnabled(j)}
                          className={cn(
                            'rounded-full px-2 py-0.5 text-xs font-medium',
                            j.enabled ? 'bg-success-bg text-positive' : 'bg-muted text-muted-foreground'
                          )}
                        >
                          {j.enabled ? 'on' : 'off'}
                        </Button>
                      </td>
                      <td className={TD}>
                        <span className="inline-flex items-center gap-2">
                          <StatusPill {...status} />
                          <span className="text-muted-foreground">{formatRelative(j.lastRunAt)}</span>
                        </span>
                      </td>
                      <td className={TD}>
                        {j.nextRunAt ? (
                          <span className="cursor-help text-muted-foreground" title={new Date(j.nextRunAt).toLocaleString()}>
                            {formatRelativeFuture(j.nextRunAt)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </td>
                      <td className={cn(TD, 'text-right')}>
                        <div className="inline-flex items-center gap-1">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            aria-label={`Run now: ${j.name}`}
                            title={isRunning ? 'Run already in progress.' : undefined}
                            disabled={isRunning}
                            onClick={() => void runNow(j)}
                          >
                            Run now
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            aria-label={`Reset ${j.name} to env`}
                            title={noOverrides ? 'No overrides to reset.' : 'Reset to env default'}
                            disabled={isRunning || noOverrides}
                            onClick={() => void resetOverrides(j)}
                          >
                            <RotateCcw size={14} />
                          </Button>
                        </div>
                      </td>
                    </tr>
                    {isExpanded ? (
                      <tr>
                        <td colSpan={6} className="bg-muted/20 px-3 py-2">
                          {(runs[j.name] ?? []).length === 0 ? (
                            <div className="py-1 text-sm text-muted-foreground">No runs recorded yet.</div>
                          ) : (
                            <table className="w-full text-xs">
                              <thead className="text-muted-foreground">
                                <tr>
                                  <th className="px-2 py-1 text-left font-medium">Started</th>
                                  <th className="px-2 py-1 text-left font-medium">Status</th>
                                  <th className="px-2 py-1 text-left font-medium">Duration</th>
                                  <th className="px-2 py-1 text-left font-medium">Error</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-border/60">
                                {(runs[j.name] ?? []).map((run) => {
                                  const runPill = runStatus(run)
                                  return (
                                    <tr key={run.id}>
                                      <td className="px-2 py-1" title={new Date(run.startedAt).toLocaleString()}>
                                        {formatRelative(run.startedAt)}
                                      </td>
                                      <td className="px-2 py-1"><StatusPill {...runPill} /></td>
                                      <td className="px-2 py-1">{formatDuration(run.durationMs)}</td>
                                      <td className="px-2 py-1 text-muted-foreground">{run.errorMessage ?? '-'}</td>
                                    </tr>
                                  )
                                })}
                              </tbody>
                            </table>
                          )}
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
