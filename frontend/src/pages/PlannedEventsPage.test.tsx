import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ToastProvider } from '@/components/ui/toast'
import { PlannedEventsPage } from './PlannedEventsPage'

const plannedEvent = {
  id: 1,
  userId: 1,
  householdId: 1,
  accountId: 1,
  type: 'expense',
  name: 'Rent',
  amount: '1800.0000',
  currency: 'CAD',
  expectedDate: '2026-07-01',
  recurrenceRule: 'FREQ=MONTHLY',
  source: 'manual',
  status: 'planned',
  linkedTransactionId: null,
  notes: null,
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
}

const account = {
  id: 1,
  name: 'Everyday Chequing',
  closedAt: null,
}

// Mutable so individual tests can swap the planned-events payload (e.g. empty).
let plannedEvents: unknown[] = [plannedEvent]

vi.mock('../lib/api', () => ({
  getJson: vi.fn((url: string) => {
    if (url.startsWith('/api/planned-events')) {
      return Promise.resolve({ data: plannedEvents })
    }
    if (url.startsWith('/api/accounts')) {
      return Promise.resolve([account])
    }
    return Promise.resolve({})
  }),
  postJson: vi.fn(() => Promise.resolve({})),
  putJson: vi.fn(() => Promise.resolve({})),
  deleteReq: vi.fn(() => Promise.resolve(undefined)),
}))

afterEach(() => {
  plannedEvents = [plannedEvent]
})

function renderPage() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <PlannedEventsPage />
      </ToastProvider>
    </MemoryRouter>,
  )
}

describe('PlannedEventsPage', () => {
  it('renders the page header', async () => {
    renderPage()
    expect(
      await screen.findByRole('heading', { name: /^planned events$/i, level: 1 }),
    ).toBeInTheDocument()
  })

  it('renders the table column headers', async () => {
    renderPage()
    expect(
      await screen.findByRole('columnheader', { name: /^date$/i }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('columnheader', { name: /^name$/i }),
    ).toBeInTheDocument()
  })

  it('renders a fetched planned event row', async () => {
    renderPage()
    expect(await screen.findByText('Rent')).toBeInTheDocument()
  })

  it('renders the empty state when there are no events', async () => {
    plannedEvents = []
    renderPage()
    expect(await screen.findByText(/no planned events yet/i)).toBeInTheDocument()
  })
})
