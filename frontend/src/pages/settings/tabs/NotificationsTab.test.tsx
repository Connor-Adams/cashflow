import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { NotificationsTab } from './NotificationsTab'
import * as api from '@/lib/api'

let pushPermission: NotificationPermission = 'default'
let pushServerConfigured = true
let pushBrowserSupported = true
let pushSubscribed = false
const subscribe = vi.fn<() => Promise<boolean>>()
vi.mock('@/hooks/usePushSubscription', () => ({
  usePushSubscription: () => ({
    supported: pushServerConfigured && pushBrowserSupported,
    serverConfigured: pushServerConfigured,
    browserSupported: pushBrowserSupported,
    permission: pushPermission,
    subscribed: pushSubscribed,
    busy: false,
    error: null,
    subscribe,
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

const BUDGET_PREF = {
  type: 'budget.breach',
  channelInApp: true,
  channelEmail: false,
  channelPush: false,
  digestDayOfWeek: 1,
}

function mockList(data: unknown[] = [DIGEST_PREF]) {
  return vi.spyOn(api, 'getJson').mockResolvedValue({ data } as never)
}

describe('NotificationsTab (#796)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    pushPermission = 'default'
    pushServerConfigured = true
    pushBrowserSupported = true
    pushSubscribed = false
    subscribe.mockReset()
    subscribe.mockResolvedValue(true)
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
    pushSubscribed = true
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

  it('shows an Email control only for the weekly digest (the only type that sends email)', async () => {
    mockList([BUDGET_PREF, DIGEST_PREF])
    render(<NotificationsTab />)
    await screen.findByText('Weekly spend digest')
    // Two rows, but exactly one Email checkbox — on the digest row.
    expect(screen.getAllByLabelText('In-app')).toHaveLength(2)
    expect(screen.getAllByLabelText('Email')).toHaveLength(1)
    const budgetRow = screen.getByText('Budget alerts').closest('li') as HTMLElement
    expect(within(budgetRow).queryByLabelText('Email')).not.toBeInTheDocument()
  })

  it('disables push with a hint when the server has no push configured', async () => {
    pushServerConfigured = false
    mockList()
    render(<NotificationsTab />)
    await screen.findByText('Weekly spend digest')
    expect(screen.getByLabelText('Push')).toBeDisabled()
    expect(screen.getByText(/Push notifications aren’t set up on this server/)).toBeInTheDocument()
  })

  it('disables push with a hint when the browser cannot do push', async () => {
    pushBrowserSupported = false
    mockList()
    render(<NotificationsTab />)
    await screen.findByText('Weekly spend digest')
    expect(screen.getByLabelText('Push')).toBeDisabled()
    expect(screen.getByText(/This browser doesn’t support push notifications/)).toBeInTheDocument()
  })

  it('subscribes this browser before saving when push is turned on and not yet subscribed', async () => {
    const user = userEvent.setup()
    mockList()
    const patch = vi.spyOn(api, 'patchJson').mockResolvedValue({
      ...DIGEST_PREF,
      channelPush: true,
    } as never)

    render(<NotificationsTab />)
    await screen.findByText('Weekly spend digest')
    await user.click(screen.getByLabelText('Push'))

    await waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(
        '/api/users/me/notifications/preferences/digest.weekly',
        { channelPush: true },
      ),
    )
  })

  it('does not save push ON when the browser subscription fails', async () => {
    const user = userEvent.setup()
    subscribe.mockResolvedValue(false)
    mockList()
    const patch = vi.spyOn(api, 'patchJson')

    render(<NotificationsTab />)
    await screen.findByText('Weekly spend digest')
    await user.click(screen.getByLabelText('Push'))

    expect(await screen.findByText(/Couldn’t enable push in this browser/)).toBeInTheDocument()
    expect(patch).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Push')).not.toBeChecked()
  })

  it('does not re-subscribe when turning push off', async () => {
    const user = userEvent.setup()
    mockList([{ ...DIGEST_PREF, channelPush: true }])
    vi.spyOn(api, 'patchJson').mockResolvedValue({ ...DIGEST_PREF, channelPush: false } as never)

    render(<NotificationsTab />)
    await screen.findByText('Weekly spend digest')
    await user.click(screen.getByLabelText('Push'))

    await waitFor(() => expect(screen.getByLabelText('Push')).not.toBeChecked())
    expect(subscribe).not.toHaveBeenCalled()
  })
})
