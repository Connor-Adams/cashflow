import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { ToastProvider } from '@/components/ui/toast'
import type { ForecastEvent, ForecastResponse } from '@/types/api'

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

function outEvent(partial: Partial<ForecastEvent>): ForecastEvent {
  return {
    date: '2026-07-01',
    amount: 100,
    direction: 'out',
    sourceType: 'planned_event',
    sourceId: 1,
    sourceName: 'Charge',
    accountId: 1,
    ...partial,
  }
}

/** A forecast that dips below zero, with attributable out-occurrences. */
const dip: ForecastResponse = {
  currency: 'CAD',
  dateFrom: '2026-06-18',
  dateTo: '2026-07-17',
  openingBalance: 1000,
  projectedClosingBalance: 200,
  lowestProjectedBalance: -350,
  lowestProjectedBalanceDate: '2026-07-01',
  dailyPoints: [
    { date: '2026-06-18', balance: 1000 },
    { date: '2026-07-01', balance: -350 },
    { date: '2026-07-17', balance: 200 },
  ],
  events: [
    outEvent({
      date: '2026-07-01',
      amount: 1200,
      sourceType: 'planned_event',
      sourceId: 42,
      sourceName: 'Rent',
    }),
    outEvent({
      date: '2026-06-30',
      amount: 150,
      sourceType: 'recurring_detection',
      sourceId: 7,
      sourceName: 'Streaming',
    }),
    {
      date: '2026-06-25',
      amount: 5000,
      direction: 'in',
      sourceType: 'planned_event',
      sourceId: 99,
      sourceName: 'Salary',
      accountId: 1,
    },
    outEvent({
      date: '2026-07-10',
      amount: 9999,
      sourceType: 'planned_event',
      sourceId: 50,
      sourceName: 'After the dip',
    }),
  ],
}

/** A dip whose drivers exceed the 8-row cap (AC6). */
const dipManyDrivers: ForecastResponse = {
  ...dip,
  events: Array.from({ length: 11 }, (_, i) =>
    outEvent({
      date: '2026-07-01',
      amount: 1000 - i, // strictly descending so order is deterministic
      sourceType: 'planned_event',
      sourceId: 100 + i,
      sourceName: `Driver ${i}`,
    }),
  ),
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

describe('ForecastPage shortfall drilldown', () => {
  it('does not render the drilldown toggle when the balance never dips', async () => {
    forecastPayload = populated // lowestProjectedBalance is positive
    await renderPage()
    await screen.findByRole('heading', { name: /^forecast$/i, level: 1 })
    expect(
      screen.queryByRole('button', { name: /what's driving this dip/i }),
    ).not.toBeInTheDocument()
  })

  it('shows a "What\'s driving this dip?" toggle when the balance dips below zero', async () => {
    forecastPayload = dip
    await renderPage()
    expect(
      await screen.findByRole('button', { name: /what's driving this dip/i }),
    ).toBeInTheDocument()
  })

  it('expands to list driver rows and flips the label to "Hide drivers"', async () => {
    forecastPayload = dip
    await renderPage()
    const toggle = await screen.findByRole('button', {
      name: /what's driving this dip/i,
    })
    await userEvent.click(toggle)

    expect(
      screen.getByRole('button', { name: /hide drivers/i }),
    ).toBeInTheDocument()

    // The drilldown is a labelled region; scope queries to it so we don't
    // collide with the same names in the upcoming-events table below.
    const drilldown = screen.getByRole('region', { name: /dip drivers/i })
    // Rent (out, on the dip date) is a driver; Salary (in) and the
    // post-dip charge are not.
    expect(within(drilldown).getByText('Rent')).toBeInTheDocument()
    expect(within(drilldown).getByText('Streaming')).toBeInTheDocument()
    expect(within(drilldown).queryByText('Salary')).not.toBeInTheDocument()
    expect(within(drilldown).queryByText('After the dip')).not.toBeInTheDocument()
  })

  it('links a planned_event driver to /planned?focus=<id>', async () => {
    forecastPayload = dip
    await renderPage()
    await userEvent.click(
      await screen.findByRole('button', { name: /what's driving this dip/i }),
    )
    const drilldown = screen.getByRole('region', { name: /dip drivers/i })
    const link = within(drilldown).getByRole('link', { name: /rent/i })
    expect(link).toHaveAttribute('href', '/planned?focus=42')
  })

  it('links a recurring_detection driver to /planned/recurring with a Detected charge tag', async () => {
    forecastPayload = dip
    await renderPage()
    await userEvent.click(
      await screen.findByRole('button', { name: /what's driving this dip/i }),
    )
    const drilldown = screen.getByRole('region', { name: /dip drivers/i })
    const link = within(drilldown).getByRole('link', { name: /streaming/i })
    expect(link).toHaveAttribute('href', '/planned/recurring')
    expect(within(drilldown).getByText(/detected charge/i)).toBeInTheDocument()
  })

  it('caps at 8 drivers and reveals the rest behind "+N more"', async () => {
    forecastPayload = dipManyDrivers
    await renderPage()
    await userEvent.click(
      await screen.findByRole('button', { name: /what's driving this dip/i }),
    )
    const drilldown = screen.getByRole('region', { name: /dip drivers/i })
    // 11 drivers total → 8 visible, 3 hidden.
    expect(within(drilldown).getByText('Driver 0')).toBeInTheDocument()
    expect(within(drilldown).getByText('Driver 7')).toBeInTheDocument()
    expect(within(drilldown).queryByText('Driver 8')).not.toBeInTheDocument()

    const more = within(drilldown).getByRole('button', { name: /\+3 more/i })
    await userEvent.click(more)
    expect(within(drilldown).getByText('Driver 8')).toBeInTheDocument()
    expect(within(drilldown).getByText('Driver 10')).toBeInTheDocument()
  })

  it('makes the upcoming-table source name a deep link', async () => {
    forecastPayload = dip
    await renderPage()
    // The upcoming table is rendered below; the planned-event row links to
    // its focus target, the detected row to the recurring list.
    const rentLinks = await screen.findAllByRole('link', { name: 'Rent' })
    expect(rentLinks.some((l) => l.getAttribute('href') === '/planned?focus=42')).toBe(
      true,
    )
    const streamingLinks = screen.getAllByRole('link', { name: 'Streaming' })
    expect(
      streamingLinks.some((l) => l.getAttribute('href') === '/planned/recurring'),
    ).toBe(true)
  })
})
