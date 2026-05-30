import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ToastProvider } from '@/components/ui/toast'
import { NotificationsTab } from './NotificationsTab'
import * as api from '@/lib/api'

function renderTab() {
  return render(
    <ToastProvider>
      <NotificationsTab />
    </ToastProvider>,
  )
}

describe('NotificationsTab', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('renders the heading', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValue({ data: [] } as never)
    renderTab()
    expect(
      await screen.findByRole('heading', { name: /^notifications$/i }),
    ).toBeInTheDocument()
  })

  it('shows an empty state when there are no known types yet', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValue({ data: [] } as never)
    renderTab()
    expect(
      await screen.findByText(/no notification types yet/i),
    ).toBeInTheDocument()
  })

  it('lists known types with in-app + email checkboxes (AC #12)', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValue({
      data: [
        { type: 'budget.breach', channelInApp: true, channelEmail: false },
        { type: 'insight.new', channelInApp: false, channelEmail: false },
      ],
    } as never)
    renderTab()
    expect(await screen.findByText(/budget breach/i)).toBeInTheDocument()
    expect(screen.getByText(/insight new/i)).toBeInTheDocument()
    // Checkboxes per row
    expect(
      screen.getByRole('checkbox', { name: /in-app for budget.breach/i }),
    ).toBeChecked()
    expect(
      screen.getByRole('checkbox', { name: /in-app for insight.new/i }),
    ).not.toBeChecked()
    expect(
      screen.getByRole('checkbox', { name: /email for budget.breach/i }),
    ).not.toBeChecked()
  })

  it('toggling a checkbox PATCHes the preference (AC #12)', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValue({
      data: [{ type: 'budget.breach', channelInApp: true, channelEmail: false }],
    } as never)
    const patchSpy = vi.spyOn(api, 'patchJson').mockResolvedValue({
      type: 'budget.breach',
      channelInApp: true,
      channelEmail: true,
    } as never)

    renderTab()
    const emailBox = await screen.findByRole('checkbox', {
      name: /email for budget.breach/i,
    })
    await userEvent.click(emailBox)

    await waitFor(() => {
      expect(patchSpy).toHaveBeenCalledWith(
        '/api/users/me/notifications/preferences/budget.breach',
        { channelEmail: true },
      )
    })
  })
})
