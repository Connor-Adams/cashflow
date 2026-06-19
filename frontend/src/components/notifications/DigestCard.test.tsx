import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DigestCard } from './DigestCard'
import type { Notification } from '@/types/api'

function digestNotification(dataJson: Record<string, unknown> | null): Notification {
  return {
    id: 1,
    type: 'digest.weekly',
    severity: 'info',
    title: 'Weekly digest: Mon, May 25 – Sun, May 31',
    body: 'CAD 420.00 spent, top: Groceries',
    dataJson,
    readAt: null,
    createdAt: new Date().toISOString(),
  }
}

const fullPayload = {
  weekStart: '2026-05-25',
  weekEnd: '2026-05-31',
  currency: 'CAD',
  netChange: -420,
  categoryDeltas: [
    { category: 'Groceries', currency: 'CAD', total: 420, priorTotal: 355, delta: 65 },
    { category: 'Dining', currency: 'CAD', total: 80, priorTotal: 100, delta: -20 },
  ],
  openInsightCount: 4,
  topInsights: [
    { id: 91, type: 'subscription_price_increase', severity: 'warning', title: 'Netflix went up $3/mo' },
  ],
  upcomingExpectations: [
    { id: 33, name: 'Rent', dueDate: '2026-06-06', amount: 2200, currency: 'CAD' },
  ],
}

describe('DigestCard (#796)', () => {
  it('collapsed shows the title and net change', () => {
    render(<DigestCard notification={digestNotification(fullPayload)} />)
    expect(screen.getByText(/Weekly digest/)).toBeInTheDocument()
    expect(screen.getByText(/Net .* this week/)).toBeInTheDocument()
    // Collapsed: section content not yet rendered.
    expect(screen.queryByText('Category changes')).not.toBeInTheDocument()
  })

  it('expands to show category deltas, top insights, and upcoming expectations (AC #11)', async () => {
    const user = userEvent.setup()
    render(<DigestCard notification={digestNotification(fullPayload)} />)
    await user.click(screen.getByTestId('digest-card-toggle'))

    expect(screen.getByText('Category changes')).toBeInTheDocument()
    expect(screen.getByText('Groceries')).toBeInTheDocument()
    expect(screen.getByText('Dining')).toBeInTheDocument()
    expect(screen.getByText(/Top open insights/)).toBeInTheDocument()
    expect(screen.getByText('Netflix went up $3/mo')).toBeInTheDocument()
    expect(screen.getByText('Coming up next week')).toBeInTheDocument()
    expect(screen.getByText('Rent')).toBeInTheDocument()
  })

  it('starts expanded when defaultExpanded (deep-link from push)', () => {
    render(<DigestCard notification={digestNotification(fullPayload)} defaultExpanded />)
    expect(screen.getByText('Category changes')).toBeInTheDocument()
  })

  it('degrades to headline-only when enriched fields are absent (AC #12)', async () => {
    const user = userEvent.setup()
    // Pre-#796 thin payload.
    const thin = { weekStart: '2026-05-25', weekEnd: '2026-05-31', currency: 'CAD', totalSpend: 420 }
    render(<DigestCard notification={digestNotification(thin)} />)
    // No net-change line in collapsed view (falls back to body).
    expect(screen.queryByText(/Net .* this week/)).not.toBeInTheDocument()
    await user.click(screen.getByTestId('digest-card-toggle'))
    expect(
      screen.getByText(/This digest summary is unavailable/),
    ).toBeInTheDocument()
    expect(screen.queryByText('Category changes')).not.toBeInTheDocument()
  })

  it('does not throw on a null dataJson', () => {
    expect(() =>
      render(<DigestCard notification={digestNotification(null)} />),
    ).not.toThrow()
  })
})
