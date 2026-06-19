import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { LatestAlertsTile } from './LatestAlertsTile'
import { deepLinkForNotification } from '@/lib/notificationLinks'
import type { Notification } from '@/types/api'

vi.mock('@/lib/api', () => ({
  getJson: vi.fn(),
  postJson: vi.fn(),
}))
import { getJson } from '@/lib/api'

vi.mock('@/lib/appConfig', () => ({
  getAppConfig: vi.fn(() => ({
    logoDevToken: null,
    quoteProviderConfigured: false,
    vapidPublicKey: null,
  })),
}))

const pushState = {
  supported: false,
  permission: 'default' as NotificationPermission,
  subscribed: false,
  busy: false,
  error: null as string | null,
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
}
vi.mock('@/hooks/usePushSubscription', () => ({
  usePushSubscription: () => pushState,
}))

function notif(over: Partial<Notification> = {}): Notification {
  return {
    id: 1,
    type: 'budget.breach',
    severity: 'warn',
    title: 'Groceries over budget',
    body: 'You are at 105% of your Groceries budget.',
    dataJson: { budgetId: 42 },
    readAt: null,
    createdAt: new Date().toISOString(),
    ...over,
  }
}

describe('LatestAlertsTile', () => {
  beforeEach(() => {
    vi.mocked(getJson).mockReset()
    // Reset the mocked push-subscription state to the "unsupported" default.
    pushState.supported = false
    pushState.permission = 'default'
    pushState.subscribed = false
    pushState.busy = false
  })

  afterEach(() => {
    delete (window as unknown as { PushManager?: unknown }).PushManager
  })

  it('AC8: renders the titled tile with up to 5 newest notifications', async () => {
    vi.mocked(getJson).mockResolvedValue({
      data: [notif({ id: 1, title: 'Groceries over budget' }), notif({ id: 2, title: 'Weekly digest ready', type: 'digest.weekly', severity: 'info', dataJson: null })],
    })
    render(
      <MemoryRouter>
        <LatestAlertsTile />
      </MemoryRouter>,
    )
    expect(await screen.findByText("Latest alerts & this week's digest")).toBeInTheDocument()
    expect(await screen.findByText('Groceries over budget')).toBeInTheDocument()
    expect(screen.getByText('Weekly digest ready')).toBeInTheDocument()
  })

  it('AC8: empty state shows the exact caught-up copy', async () => {
    vi.mocked(getJson).mockResolvedValue({ data: [] })
    render(
      <MemoryRouter>
        <LatestAlertsTile />
      </MemoryRouter>,
    )
    expect(await screen.findByText("You're all caught up")).toBeInTheDocument()
    expect(
      screen.getByText('New budget alerts and your weekly digest will show up here.'),
    ).toBeInTheDocument()
  })

  it('AC12: a list-fetch failure renders the error copy + Retry', async () => {
    vi.mocked(getJson).mockRejectedValue(new Error('boom'))
    render(
      <MemoryRouter>
        <LatestAlertsTile />
      </MemoryRouter>,
    )
    expect(await screen.findByText("Couldn't load your alerts.")).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument()
  })

  it('AC11: each notification links to its deep link', async () => {
    vi.mocked(getJson).mockResolvedValue({
      data: [notif({ id: 1, title: 'Groceries over budget', dataJson: { budgetId: 42 } })],
    })
    render(
      <MemoryRouter>
        <LatestAlertsTile />
      </MemoryRouter>,
    )
    const link = await screen.findByRole('link', { name: /groceries over budget/i })
    expect(link).toHaveAttribute('href', '/budgets')
  })

  it('AC9: the "Enable browser alerts" control is hidden when push is unsupported', async () => {
    pushState.supported = false
    vi.mocked(getJson).mockResolvedValue({ data: [] })
    render(
      <MemoryRouter>
        <LatestAlertsTile />
      </MemoryRouter>,
    )
    await screen.findByText("You're all caught up")
    expect(screen.queryByRole('button', { name: /enable browser alerts/i })).toBeNull()
  })

  it('AC9: shows the exact "Enable browser alerts" CTA when supported', async () => {
    pushState.supported = true
    pushState.permission = 'default'
    vi.mocked(getJson).mockResolvedValue({ data: [] })
    render(
      <MemoryRouter>
        <LatestAlertsTile />
      </MemoryRouter>,
    )
    expect(
      await screen.findByRole('button', { name: 'Enable browser alerts' }),
    ).toBeInTheDocument()
  })

  it('AC9: shows the disabled "Blocked in browser settings" state when permission is denied', async () => {
    pushState.supported = true
    pushState.permission = 'denied'
    vi.mocked(getJson).mockResolvedValue({ data: [] })
    render(
      <MemoryRouter>
        <LatestAlertsTile />
      </MemoryRouter>,
    )
    const blocked = await screen.findByRole('button', { name: /blocked in browser settings/i })
    expect(blocked).toBeDisabled()
    expect(screen.queryByRole('button', { name: /enable browser alerts/i })).toBeNull()
  })
})

describe('deepLinkForNotification', () => {
  it('prefers an explicit dataJson.link', () => {
    expect(
      deepLinkForNotification(notif({ dataJson: { link: '/custom' } })),
    ).toBe('/custom')
  })
  it('falls back to /budgets for a budget breach', () => {
    expect(deepLinkForNotification(notif({ type: 'budget.breach', dataJson: null }))).toBe(
      '/budgets',
    )
  })
  it('falls back to / for the weekly digest', () => {
    expect(
      deepLinkForNotification(notif({ type: 'digest.weekly', dataJson: null })),
    ).toBe('/')
  })
})
