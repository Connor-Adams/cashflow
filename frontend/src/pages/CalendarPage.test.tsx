import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ToastProvider } from '@/components/ui/toast'
import { CalendarPage } from './CalendarPage'

// Mock the data layer at the api module level (same pattern as LifestyleInflationPage.test.tsx).
// CalendarPage calls getJson('/api/calendar/events?...') twice (month window + upcoming 14-day)
// and getJson('/api/accounts') once. We branch on the URL substring to serve the correct shape.
vi.mock('../lib/api', () => ({
  getJson: vi.fn((url: string) => {
    if ((url as string).includes('/api/accounts')) {
      return Promise.resolve([
        {
          id: 1,
          name: 'Chequing',
          owner: 'me',
          householdId: null,
          ownerUserId: null,
          visibility: 'shared' as const,
          accountType: 'chequing' as const,
          shortCode: null,
          defaultCurrency: 'CAD',
          closedAt: null,
        },
      ])
    }
    // /api/calendar/events?... — serve a couple of events for both the month
    // window fetch and the upcoming-14-day fetch.
    return Promise.resolve({
      from: '2026-06-01',
      to: '2026-06-30',
      events: [
        {
          id: 101,
          eventDate: '2026-06-20',
          type: 'expense' as const,
          kindLabel: 'Expense',
          categoryColor: 'rose',
          name: 'Rent',
          amount: '2000',
          currency: 'CAD',
          status: 'planned' as const,
          anchorDate: '2026-06-20',
          recurrenceRule: null,
          accountId: null,
          linkedTransactionId: null,
          notes: null,
        },
        {
          id: 102,
          eventDate: '2026-06-25',
          type: 'income' as const,
          kindLabel: 'Income',
          categoryColor: 'emerald',
          name: 'Paycheque',
          amount: '5000',
          currency: 'CAD',
          status: 'planned' as const,
          anchorDate: '2026-06-25',
          recurrenceRule: null,
          accountId: null,
          linkedTransactionId: null,
          notes: null,
        },
      ],
    })
  }),
  postJson: vi.fn(() => Promise.resolve({})),
  putJson: vi.fn(() => Promise.resolve({})),
  deleteReq: vi.fn(() => Promise.resolve(undefined)),
}))

function renderPage() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <CalendarPage />
      </ToastProvider>
    </MemoryRouter>,
  )
}

describe('CalendarPage', () => {
  it('renders the page heading', async () => {
    renderPage()
    expect(
      await screen.findByRole('heading', { name: /financial calendar/i, level: 1 }),
    ).toBeInTheDocument()
  })

  it('renders the Month and List view tabs', async () => {
    renderPage()
    // Tabs component renders tab triggers with role="tab"
    expect(await screen.findByRole('tab', { name: /^month$/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /^list$/i })).toBeInTheDocument()
  })

  it('renders the Next 14 days summary card heading', async () => {
    renderPage()
    // UpcomingSummaryCard renders an h2 with "Next 14 days"
    expect(await screen.findByRole('heading', { name: /next 14 days/i, level: 2 })).toBeInTheDocument()
  })

  it('renders the upcoming summary stat labels', async () => {
    renderPage()
    // UpcomingSummaryCard Stat tiles render muted labels: "Expected in", "Expected out", "Net"
    expect(await screen.findByText('Expected in')).toBeInTheDocument()
    expect(screen.getByText('Expected out')).toBeInTheDocument()
    expect(screen.getByText('Net')).toBeInTheDocument()
  })
})
