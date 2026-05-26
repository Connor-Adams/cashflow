import { Fragment, useCallback, useEffect, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/toast'
import { cn } from '@/lib/utils'
import { getJson, patchJson, postJson } from '../../../lib/api'
import type { JobRunOutcome, JobRunView, JobView } from '../../../types/jobs'

function formatRelative(iso: string | null): string {
  if (!iso) return 'Never run'
  const d = new Date(iso)
  const diffMs = Date.now() - d.getTime()
  if (diffMs < 60_000) return 'just now'
  const mins = Math.round(diffMs / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return d.toLocaleString()
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '-'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)}s`
}

function scheduleLabel(cron: string | null): string {
  if (!cron || cron === 'manual') return 'Manual'
  return cron
}

function truncatedError(message: string): string {
  return message.length <= 96 ? message : `${message.slice(0, 93)}...`
}

function jobStatus(job: JobView, running: boolean) {
  if (running) return { label: 'Running', className: 'bg-blue-100 text-blue-800' }
  switch (job.lastStatus) {
    case 'ok':
      return { label: 'Success', className: 'bg-emerald-100 text-emerald-800' }
    case 'error':
      return { label: 'Failure', className: 'bg-red-100 text-red-800' }
    case 'skipped_disabled':
    case 'skipped_locked':
    case 'skipped_reentrant':
      return { label: 'Success', className: 'bg-emerald-100 text-emerald-800' }
    default:
      return { label: 'Never run', className: 'bg-slate-100 text-slate-700' }
  }
}

function runStatus(run: JobRunView) {
  switch (run.status) {
    case 'success':
      return { label: 'Success', className: 'bg-emerald-100 text-emerald-800' }
    case 'failed':
      return { label: 'Failure', className: 'bg-red-100 text-red-800' }
    case 'running':
      return { label: 'Running', className: 'bg-blue-100 text-blue-800' }
    default:
      return { label: 'Skipped', className: 'bg-slate-100 text-slate-700' }
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
        <button
          type="button"
          role="switch"
          aria-checked={autoRefresh}
          aria-label="Auto-refresh"
          onClick={() => setAutoRefresh((v) => !v)}
          className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm"
        >
          <span className={cn('h-2 w-2 rounded-full', autoRefresh ? 'bg-emerald-500' : 'bg-slate-400')} />
          Auto-refresh
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
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
        <table className="dataTable">
          <thead>
            <tr>
              <th>Job</th>
              <th>Schedule</th>
              <th>Enabled</th>
              <th>Last run</th>
              <th>Status</th>
              <th>Duration</th>
              <th>Next run</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => {
              const isExpanded = Boolean(expanded[j.name])
              const isRunning = Boolean(busy[j.name])
              const status = jobStatus(j, isRunning)
              return (
                <Fragment key={j.name}>
                  <tr key={j.name}>
                    <td>
                      <button
                        type="button"
                        aria-label={`${isExpanded ? 'Hide' : 'Show'} runs for ${j.name}`}
                        onClick={() => void toggleExpanded(j)}
                        className="inline-flex items-center gap-1 font-medium"
                      >
                        {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                        {j.name}
                      </button>
                    </td>
                    <td>{scheduleLabel(j.cron)}</td>
                    <td>
                      <button
                        role="switch"
                        aria-checked={j.enabled}
                        aria-label={`${j.name} enabled`}
                        disabled={isRunning}
                        onClick={() => void toggleEnabled(j)}
                      >
                        {j.enabled ? 'on' : 'off'}
                      </button>
                    </td>
                    <td>{formatRelative(j.lastRunAt)}</td>
                    <td><StatusPill {...status} /></td>
                    <td>{formatDuration(j.lastDurationMs)}</td>
                    <td>{j.nextRunAt ? new Date(j.nextRunAt).toLocaleString() : '-'}</td>
                    <td>
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
                        disabled={isRunning || (j.source.enabled === 'env' && j.source.cron === 'env')}
                        onClick={() => void resetOverrides(j)}
                      >
                        Reset to env
                      </Button>
                    </td>
                  </tr>
                  {isExpanded ? (
                    <tr key={`${j.name}-runs`}>
                      <td colSpan={8}>
                        {(runs[j.name] ?? []).length === 0 ? (
                          <div className="py-3 text-sm text-muted-foreground">No runs recorded yet.</div>
                        ) : (
                          <div className="py-2">
                            <table className="dataTable">
                              <thead>
                                <tr>
                                  <th>Started</th>
                                  <th>Status</th>
                                  <th>Duration</th>
                                  <th>Error</th>
                                </tr>
                              </thead>
                              <tbody>
                                {(runs[j.name] ?? []).map((run) => {
                                  const runPill = runStatus(run)
                                  return (
                                    <tr key={run.id}>
                                      <td>{new Date(run.startedAt).toLocaleString()}</td>
                                      <td><StatusPill {...runPill} /></td>
                                      <td>{formatDuration(run.durationMs)}</td>
                                      <td>{run.errorMessage ?? '-'}</td>
                                    </tr>
                                  )
                                })}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
