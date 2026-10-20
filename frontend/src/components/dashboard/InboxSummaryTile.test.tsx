import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { PolledCount } from '@/hooks/usePolledCount'

const inbox = vi.fn<() => PolledCount>()
const insights = vi.fn<() => PolledCount>()
vi.mock('@/hooks/useAiInboxCount', () => ({ useAiInboxCount: () => inbox() }))
vi.mock('@/hooks/useInsightsCount', () => ({ useInsightsCount: () => insights() }))

import { InboxSummaryTile } from './InboxSummaryTile'

function polled(overrides: Partial<PolledCount>): PolledCount {
  return { count: 0, loading: false, error: false, refetch: vi.fn(), ...overrides }
}

function renderTile() {
  return render(
    <MemoryRouter>
      <InboxSummaryTile />
    </MemoryRouter>,
  )
}

afterEach(() => {
  inbox.mockReset()
  insights.mockReset()
})

describe('InboxSummaryTile', () => {
  it('shows "All clear" when both counts are a real 0', () => {
    inbox.mockReturnValue(polled({ count: 0 }))
    insights.mockReturnValue(polled({ count: 0 }))
    renderTile()
    expect(screen.getByText('All clear')).toBeInTheDocument()
  })

  it('shows the pending total on success', () => {
    inbox.mockReturnValue(polled({ count: 2 }))
    insights.mockReturnValue(polled({ count: 1 }))
    renderTile()
    expect(screen.getByText('3 pending')).toBeInTheDocument()
  })

  it('renders an error with Retry, not "All clear", when a count fetch failed', () => {
    const refetchInbox = vi.fn()
    const refetchInsights = vi.fn()
    inbox.mockReturnValue(polled({ count: null, error: true, refetch: refetchInbox }))
    insights.mockReturnValue(polled({ count: 0, refetch: refetchInsights }))
    renderTile()
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load the inbox count")
    expect(screen.queryByText('All clear')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(refetchInbox).toHaveBeenCalled()
    expect(refetchInsights).toHaveBeenCalled()
  })

  it('keeps showing the last good total when a refetch fails', () => {
    inbox.mockReturnValue(polled({ count: 4, error: true }))
    insights.mockReturnValue(polled({ count: 1 }))
    renderTile()
    expect(screen.getByText('5 pending')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('does not claim "All clear" while still loading', () => {
    inbox.mockReturnValue(polled({ count: null, loading: true }))
    insights.mockReturnValue(polled({ count: null, loading: true }))
    renderTile()
    expect(screen.queryByText('All clear')).not.toBeInTheDocument()
  })
})
