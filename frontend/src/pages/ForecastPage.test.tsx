import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ToastProvider } from '@/components/ui/toast'
import type { ForecastResponse } from '@/types/api'

// Recharts + jsdom throws on a zero-size ResponsiveContainer. Render its
// children in a fixed-size div so the AreaChart mounts without measuring.
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>()
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div style={{ width: 600, height: 320 }}>{children}</div>
    ),
  }
})

// ForecastPage funnels its data through useForecast -> getJson('/api/forecast').
// Route-aware mock so the page renders against a realistic ForecastResponse.
const populated: ForecastResponse = {
  currency: 'CAD',
  dateFrom: '2026-06-18',
  dateTo: '2026-07-17',
  openingBalance: 5000,
  projectedClosingBalance: 4200,
  lowestProjectedBalance: 1500,
  lowestProjectedBalanceDate: '2026-07-01',
  dailyPoints: [
    { date: '2026-06-18', balance: 5000 },
    { date: '2026-07-01', balance: 1500 },
    { date: '2026-07-17', balance: 4200 },
  ],
  events: [
    {
      date: '2026-07-01',
      amount: 1200,
      direction: 'out',
      sourceType: 'planned_event',
      sourceId: 42,
      sourceName: 'Rent',
      accountId: 1,
    },
  ],
}

const empty: ForecastResponse = {
  currency: 'CAD',
  dateFrom: '2026-06-18',
  dateTo: '2026-07-17',
  openingBalance: 0,
  projectedClosingBalance: 0,
  lowestProjectedBalance: 0,
  lowestProjectedBalanceDate: null,
  dailyPoints: [],
  events: [],
}

let forecastPayload: ForecastResponse = populated

vi.mock('@/lib/api', () => ({
  getJson: vi.fn((path: string) => {
    if (path.startsWith('/api/forecast')) {
      return Promise.resolve(forecastPayload)
    }
    return Promise.reject(new Error(`unmocked endpoint: ${path}`))
  }),
  postJson: vi.fn(() => Promise.resolve({})),
  putJson: vi.fn(() => Promise.resolve({})),
  patchJson: vi.fn(() => Promise.resolve({})),
  deleteReq: vi.fn(() => Promise.resolve(undefined)),
}))

async function renderPage() {
  const { ForecastPage } = await import('./ForecastPage')
  return render(
    <MemoryRouter>
      <ToastProvider>
        <ForecastPage />
      </ToastProvider>
    </MemoryRouter>,
  )
}

describe('ForecastPage (characterization)', () => {
  it('renders the page heading', async () => {
    forecastPayload = populated
    await renderPage()
    expect(
      await screen.findByRole('heading', { name: /^forecast$/i, level: 1 }),
    ).toBeInTheDocument()
  })

  it('renders the summary-tile labels', async () => {
    forecastPayload = populated
    await renderPage()
    expect(await screen.findByText(/opening balance/i)).toBeInTheDocument()
    expect(await screen.findByText(/projected closing/i)).toBeInTheDocument()
  })

  it('renders the upcoming events table with a header and an event row', async () => {
    forecastPayload = populated
    await renderPage()
    // Column header from the upcoming inflows/outflows table.
    expect(
      await screen.findByRole('columnheader', { name: /event/i }),
    ).toBeInTheDocument()
    // The single planned event's name renders as a row cell.
    expect(await screen.findByText('Rent')).toBeInTheDocument()
  })

  it('renders the empty state when there are no events or points', async () => {
    forecastPayload = empty
    await renderPage()
    expect(await screen.findByText(/no upcoming events/i)).toBeInTheDocument()
  })
})
