import React from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { JobsTab } from './JobsTab'
import * as api from '../../../lib/api'
import type { JobView } from '../../../types/jobs'

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

describe('JobsTab', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('renders the job row from the API', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValue([baseJob])
    render(<JobsTab />)
    await waitFor(() => expect(screen.getByText('daily_snapshot')).toBeInTheDocument())
    expect(screen.getByText('0 3 * * *')).toBeInTheDocument()
    expect(screen.getByText('ok')).toBeInTheDocument()
  })

  it('toggling enabled PATCHes the API', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValue([baseJob])
    const patch = vi.spyOn(api, 'patchJson').mockResolvedValue({ ...baseJob, enabled: false })
    render(<JobsTab />)
    await waitFor(() => screen.getByText('daily_snapshot'))
    fireEvent.click(screen.getByRole('switch', { name: /daily_snapshot enabled/i }))
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/api/jobs/daily_snapshot', { enabled: false }))
  })

  it('Run now POSTs and shows the outcome', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValue([baseJob])
    const post = vi.spyOn(api, 'postJson').mockResolvedValue({ status: 'ok', durationMs: 50 })
    render(<JobsTab />)
    await waitFor(() => screen.getByText('daily_snapshot'))
    fireEvent.click(screen.getByRole('button', { name: /run now: daily_snapshot/i }))
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/jobs/daily_snapshot/run'))
  })
})
