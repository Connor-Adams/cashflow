import React from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { JobsTab } from './JobsTab'
import * as api from '../../../lib/api'
import type { JobRunView, JobView } from '../../../types/jobs'
import { ToastProvider } from '@/components/ui/toast'

const baseJob: JobView = {
  name: 'daily_snapshot',
  cron: '0 3 * * *',
  enabled: true,
  source: { enabled: 'env', cron: 'env' },
  lastRunAt: '2026-05-26T03:00:00.000Z',
  lastFinishedAt: '2026-05-26T03:00:01.000Z',
  lastStatus: 'ok',
  lastDurationMs: 1234,
  lastError: null,
  lastResultJson: null,
  nextRunAt: '2026-05-27T03:00:00.000Z',
}

const failedRun: JobRunView = {
  id: 10,
  jobName: 'daily_snapshot',
  startedAt: '2026-05-26T03:00:00.000Z',
  finishedAt: '2026-05-26T03:00:02.000Z',
  status: 'failed',
  durationMs: 2000,
  errorMessage: 'snapshot failed loudly',
}

function renderTab() {
  return render(
    <ToastProvider>
      <JobsTab />
    </ToastProvider>
  )
}

describe('JobsTab', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('renders job status and expandable run history', async () => {
    vi.spyOn(api, 'getJson').mockImplementation((path: string) => {
      if (path === '/api/jobs/daily_snapshot/runs?limit=10') return Promise.resolve([failedRun])
      return Promise.resolve([baseJob])
    })
    renderTab()
    await waitFor(() => expect(screen.getByText('daily_snapshot')).toBeInTheDocument())
    const schedule = screen.getByText('Daily at 3:00 AM')
    expect(schedule).toBeInTheDocument()
    expect(schedule).toHaveAttribute('title', '0 3 * * *')
    expect(screen.getByText('Success')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /show runs for daily_snapshot/i }))
    expect(await screen.findByText('snapshot failed loudly')).toBeInTheDocument()
    expect(screen.getByText('Failure')).toBeInTheDocument()
  })

  it('toggling enabled PATCHes the API', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValue([baseJob])
    const patch = vi.spyOn(api, 'patchJson').mockResolvedValue({ ...baseJob, enabled: false })
    renderTab()
    await waitFor(() => screen.getByText('daily_snapshot'))
    fireEvent.click(screen.getByRole('switch', { name: /daily_snapshot enabled/i }))
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/api/jobs/daily_snapshot', { enabled: false }))
  })

  it('Run now POSTs, marks the row running, and shows a completion toast', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValue([baseJob])
    const post = vi.spyOn(api, 'postJson').mockResolvedValue({
      status: 'ok',
      durationMs: 1500,
      jobName: 'daily_snapshot',
      runId: 11,
      queuedAt: '2026-05-26T04:00:00.000Z',
    })
    renderTab()
    await waitFor(() => screen.getByText('daily_snapshot'))
    fireEvent.click(screen.getByRole('button', { name: /run now: daily_snapshot/i }))
    const row = screen.getByText('daily_snapshot').closest('tr')
    expect(row).not.toBeNull()
    expect(within(row as HTMLTableRowElement).getByText('Running')).toBeInTheDocument()
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/jobs/daily_snapshot/run'))
    expect(await screen.findByText('daily_snapshot finished in 1.5s')).toBeInTheDocument()
  })

  it('polls every 10 seconds only when auto-refresh is enabled', async () => {
    const setIntervalSpy = vi
      .spyOn(window, 'setInterval')
      .mockImplementation(() => {
        return 1
      })
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval').mockImplementation(() => undefined)
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    const get = vi.spyOn(api, 'getJson').mockResolvedValue([baseJob])
    renderTab()
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1))

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 10_000)
    fireEvent.click(screen.getByRole('switch', { name: /auto-refresh/i }))
    await waitFor(() => expect(clearIntervalSpy).toHaveBeenCalledWith(1))
  })
})
