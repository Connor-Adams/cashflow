import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { ToastProvider } from '@/components/ui/toast'
import { FeedbackInboxTab } from './FeedbackInboxTab'
import * as api from '@/lib/api'

const NEWER = {
  id: 2,
  category: 'feature',
  body: 'Please add a dark theme',
  currentPath: '/dashboard',
  appVersion: 'v1',
  userAgent: 'TestBrowser/1.0',
  createdAt: new Date(Date.now() - 60_000).toISOString(),
  resolvedAt: null,
}
const OLDER = {
  id: 1,
  category: 'bug',
  body: 'The chart is blank',
  currentPath: '/reports',
  appVersion: 'v1',
  userAgent: 'TestBrowser/1.0',
  createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
  resolvedAt: null,
}

function renderTab() {
  render(
    <ToastProvider>
      <FeedbackInboxTab />
    </ToastProvider>,
  )
}

describe('FeedbackInboxTab', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('renders the Feedback inbox heading (AC#13)', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValue({ data: [], count: 0 } as never)
    renderTab()
    expect(
      await screen.findByRole('heading', { name: /feedback inbox/i }),
    ).toBeInTheDocument()
  })

  it('shows the empty state when there is no feedback', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValue({ data: [], count: 0 } as never)
    renderTab()
    expect(await screen.findByText(/no feedback yet\./i)).toBeInTheDocument()
  })

  it('lists submissions newest-first (AC#13)', async () => {
    // Server returns newest-first; the tab renders them in order.
    vi.spyOn(api, 'getJson').mockResolvedValue({
      data: [NEWER, OLDER],
      count: 2,
    } as never)
    renderTab()
    await screen.findByText('Please add a dark theme')
    const bodies = screen.getAllByTestId('feedback-body').map((el) => el.textContent)
    expect(bodies[0]).toMatch(/dark theme/i)
    expect(bodies[1]).toMatch(/chart is blank/i)
  })

  it('marks a submission resolved via POST /api/feedback/:id/resolve (AC#13)', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValue({ data: [NEWER], count: 1 } as never)
    const post = vi
      .spyOn(api, 'postJson')
      .mockResolvedValue({ ...NEWER, resolvedAt: new Date().toISOString() } as never)
    renderTab()
    await screen.findByText('Please add a dark theme')
    await userEvent.click(screen.getByRole('button', { name: /mark resolved/i }))
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/feedback/2/resolve'),
    )
  })

  it('does not show a Mark resolved action for already-resolved items', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValue({
      data: [{ ...NEWER, resolvedAt: new Date().toISOString() }],
      count: 1,
    } as never)
    renderTab()
    await screen.findByText('Please add a dark theme')
    expect(
      screen.queryByRole('button', { name: /mark resolved/i }),
    ).not.toBeInTheDocument()
  })

  it('shows an error message when the fetch fails', async () => {
    vi.spyOn(api, 'getJson').mockRejectedValue(new Error('nope'))
    renderTab()
    expect(await screen.findByText('nope')).toBeInTheDocument()
  })
})
