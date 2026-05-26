import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { NotificationBell } from './NotificationBell'
import * as api from '@/lib/api'

function mockUnreadCount(count: number) {
  return vi.spyOn(api, 'getJson').mockImplementation((path: string) => {
    if (path.includes('unread-count')) {
      return Promise.resolve({ count } as never)
    }
    return Promise.resolve({ data: [] } as never)
  })
}

describe('NotificationBell', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response),
      ),
    )
  })

  it('renders the bell button with an accessible label (AC #10)', async () => {
    mockUnreadCount(0)
    render(<NotificationBell />)
    expect(
      screen.getByRole('button', { name: /notifications/i }),
    ).toBeInTheDocument()
  })

  it('shows the unread count as a badge (AC #10)', async () => {
    mockUnreadCount(3)
    render(<NotificationBell />)
    await waitFor(() => {
      expect(screen.getByTestId('notification-badge')).toHaveTextContent('3')
    })
  })

  it('caps the badge at "99+" (AC #10)', async () => {
    mockUnreadCount(150)
    render(<NotificationBell />)
    await waitFor(() => {
      expect(screen.getByTestId('notification-badge')).toHaveTextContent('99+')
    })
  })

  it('does NOT render a badge when unread count is 0', async () => {
    mockUnreadCount(0)
    render(<NotificationBell />)
    await waitFor(() => {
      expect(screen.queryByTestId('notification-badge')).toBeNull()
    })
  })

  it('opens a popover panel on click and shows empty state (AC #11)', async () => {
    vi.spyOn(api, 'getJson').mockImplementation((path: string) => {
      if (path.includes('unread-count')) {
        return Promise.resolve({ count: 0 } as never)
      }
      return Promise.resolve({ data: [] } as never)
    })

    render(<NotificationBell />)
    const button = await screen.findByRole('button', { name: /notifications/i })
    await act(async () => {
      await userEvent.click(button)
    })

    expect(
      await screen.findByText(/you're all caught up/i),
    ).toBeInTheDocument()
  })

  it('opens a popover panel and lists notifications', async () => {
    const sample = [
      {
        id: 1,
        type: 'budget.breach',
        severity: 'warn',
        title: 'Budget over',
        body: 'You spent 1.2x budget',
        dataJson: null,
        readAt: null,
        createdAt: new Date().toISOString(),
      },
    ]
    vi.spyOn(api, 'getJson').mockImplementation((path: string) => {
      if (path.includes('unread-count')) {
        return Promise.resolve({ count: 1 } as never)
      }
      return Promise.resolve({ data: sample } as never)
    })

    render(<NotificationBell />)
    const button = await screen.findByRole('button', { name: /notifications/i })
    await act(async () => {
      await userEvent.click(button)
    })

    expect(await screen.findByText('Budget over')).toBeInTheDocument()
    expect(screen.getByText(/you spent 1\.2x budget/i)).toBeInTheDocument()
  })
})
