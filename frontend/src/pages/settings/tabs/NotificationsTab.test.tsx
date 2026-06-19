import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { NotificationsTab } from './NotificationsTab'
import * as api from '@/lib/api'

let pushPermission: NotificationPermission = 'default'
vi.mock('@/hooks/usePushSubscription', () => ({
  usePushSubscription: () => ({
    supported: true,
    permission: pushPermission,
    subscribed: false,
    busy: false,
    error: null,
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  }),
}))

const DIGEST_PREF = {
  type: 'digest.weekly',
  channelInApp: true,
  channelEmail: false,
  channelPush: false,
  digestDayOfWeek: 1,
}

function mockList() {
  return vi
    .spyOn(api, 'getJson')
    .mockResolvedValue({ data: [DIGEST_PREF] } as never)
}

describe('NotificationsTab (#796)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    pushPermission = 'default'
  })

  it('renders the digest preference with channel toggles and a day picker', async () => {
    mockList()
    render(<NotificationsTab />)
    expect(await screen.findByText('Weekly spend digest')).toBeInTheDocument()
    expect(screen.getByLabelText('In-app')).toBeChecked()
    expect(screen.getByLabelText('Email')).not.toBeChecked()
    expect(screen.getByLabelText('Push')).not.toBeChecked()
    expect(screen.getByLabelText('Digest send day')).toHaveValue('1')
  })

  it('PATCHes the preference and reflects saved state when a channel is toggled', async () => {
    const user = userEvent.setup()
    mockList()
    const patch = vi.spyOn(api, 'patchJson').mockResolvedValue({
      ...DIGEST_PREF,
      channelPush: true,
    } as never)

    render(<NotificationsTab />)
    await screen.findByText('Weekly spend digest')
    await user.click(screen.getByLabelText('Push'))

    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(
        '/api/users/me/notifications/preferences/digest.weekly',
        { channelPush: true },
      ),
    )
    await waitFor(() => expect(screen.getByLabelText('Push')).toBeChecked())
  })

  it('PATCHes digestDayOfWeek when the send day changes', async () => {
    const user = userEvent.setup()
    mockList()
    const patch = vi.spyOn(api, 'patchJson').mockResolvedValue({
      ...DIGEST_PREF,
      digestDayOfWeek: 3,
    } as never)

    render(<NotificationsTab />)
    await screen.findByText('Weekly spend digest')
    await user.selectOptions(screen.getByLabelText('Digest send day'), '3')

    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(
        '/api/users/me/notifications/preferences/digest.weekly',
        { digestDayOfWeek: 3 },
      ),
    )
  })

  it('shows the push-blocked hint and disables push when permission is denied (AC #12)', async () => {
    pushPermission = 'denied'
    mockList()
    render(<NotificationsTab />)
    await screen.findByText('Weekly spend digest')
    expect(screen.getByLabelText('Push')).toBeDisabled()
    expect(screen.getByText(/Push blocked in your browser/)).toBeInTheDocument()
  })

  it('reverts and shows an inline error when the save fails', async () => {
    const user = userEvent.setup()
    mockList()
    vi.spyOn(api, 'patchJson').mockRejectedValue(new Error('500'))

    render(<NotificationsTab />)
    await screen.findByText('Weekly spend digest')
    await user.click(screen.getByLabelText('Email'))

    expect(
      await screen.findByText(/Couldn’t save your digest settings/),
    ).toBeInTheDocument()
    // Reverted to the original unchecked state.
    await waitFor(() => expect(screen.getByLabelText('Email')).not.toBeChecked())
  })
})
