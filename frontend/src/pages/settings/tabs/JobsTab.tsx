import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { getJson, patchJson, postJson } from '../../../lib/api'
import type { JobView, JobRunOutcome } from '../../../types/jobs'

function formatRelative(iso: string | null): string {
  if (!iso) return '—'
  const t = new Date(iso).getTime()
  const diffMs = Date.now() - t
  if (diffMs < 0) return new Date(iso).toLocaleString()
  const s = Math.floor(diffMs / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return new Date(iso).toLocaleString()
}

export function JobsTab() {
  const [jobs, setJobs] = useState<JobView[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<Record<string, boolean>>({})

  const load = useCallback(async () => {
    try {
      setJobs(await getJson<JobView[]>('/api/jobs'))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load jobs')
    }
  }, [])

  useEffect(() => {
    void load()
    const id = setInterval(() => {
      if (!document.hidden) void load()
    }, 10_000)
    return () => clearInterval(id)
  }, [load])

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
    try {
      const outcome = await postJson<JobRunOutcome>(`/api/jobs/${job.name}/run`)
      setError(outcome.status === 'error' ? `Run failed: ${outcome.error}` : null)
      await load()
    } catch (e) {
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
    <div className="jobsTabRoot">
      {error && <p className="error" role="alert">{error}</p>}
      <table className="dataTable">
        <thead>
          <tr>
            <th>Job</th>
            <th>Cron</th>
            <th>Enabled</th>
            <th>Last Run</th>
            <th>Status</th>
            <th>Duration</th>
            <th>Next Run</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => (
            <tr key={j.name}>
              <td>{j.name}</td>
              <td>
                <span>{j.cron}</span>{' '}
                <span className={`badge badge-${j.source.cron}`}>{j.source.cron}</span>
              </td>
              <td>
                <button
                  role="switch"
                  aria-checked={j.enabled}
                  aria-label={`${j.name} enabled`}
                  disabled={busy[j.name]}
                  onClick={() => void toggleEnabled(j)}
                >
                  {j.enabled ? 'on' : 'off'}
                </button>
                <span className={`badge badge-${j.source.enabled}`}>{j.source.enabled}</span>
              </td>
              <td>{formatRelative(j.lastRunAt)}</td>
              <td>{j.lastStatus ?? '—'}</td>
              <td>{j.lastDurationMs != null ? `${j.lastDurationMs}ms` : '—'}</td>
              <td>{formatRelative(j.nextRunAt)}</td>
              <td>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  aria-label={`Run now: ${j.name}`}
                  disabled={busy[j.name]}
                  onClick={() => void runNow(j)}
                >
                  Run now
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busy[j.name] || (j.source.enabled === 'env' && j.source.cron === 'env')}
                  onClick={() => void resetOverrides(j)}
                >
                  Reset to env
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
