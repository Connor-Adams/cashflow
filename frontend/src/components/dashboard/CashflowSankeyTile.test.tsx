/**
 * Tests for the Dashboard's Cashflow Sankey tile (2026-09-27 full-chain spec,
 * section 4). The tile is a chart that *inherits* the dashboard's currency and
 * date range — it must not grow its own filter controls, and it must not show
 * anything outside the period the dashboard is scoped to.
 *
 * SankeyChart is mocked here: this suite is about fetching, range inheritance
 * and the link-through, not chart internals (covered by SankeyChart.test.tsx).
 */
import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

void React

vi.mock('@/components/SankeyChart', () => ({
  SankeyChart: ({ data, currency }: { data: { nodes: unknown[] }; currency: string }) => (
    <div data-testid="sankey-chart" data-currency={currency}>
      {data.nodes.length} nodes
    </div>
  ),
}))

import { CashflowSankeyTile } from './CashflowSankeyTile'

const PAYLOAD = {
  currency: 'CAD',
  totalIncome: 5000,
  totalSpend: 425,
  surplus: 4575,
  balanced: true,
  transactionCount: 4,
  nodes: [
    { name: 'Income', kind: 'income' },
    { name: 'Groceries', kind: 'category' },
    { name: 'Surplus', kind: 'surplus' },
  ],
  links: [
    { source: 0, target: 1, value: 425 },
    { source: 0, target: 2, value: 4575 },
  ],
  availableCurrencies: ['CAD'],
  dateRange: { from: '2026-01-01', to: '2026-09-27' },
}

const urls: string[] = []

function mockFetch(payload: unknown = PAYLOAD, ok = true) {
  urls.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo) => {
      urls.push(String(input))
      return Promise.resolve({
        ok,
        status: ok ? 200 : 500,
        statusText: ok ? 'OK' : 'Server Error',
        headers: new Headers(),
        json: () => Promise.resolve(payload),
        text: () => Promise.resolve(JSON.stringify(payload)),
      } as Response)
    }),
  )
}

function renderTile(props: Partial<React.ComponentProps<typeof CashflowSankeyTile>> = {}) {
  return render(
    <MemoryRouter>
      <CashflowSankeyTile
        currency="CAD"
        dateFrom="2026-01-01"
        dateTo="2026-09-27"
        {...props}
      />
    </MemoryRouter>,
  )
}

describe('CashflowSankeyTile', () => {
  beforeEach(() => {
    mockFetch()
  })

  it('fetches the Sankey scoped to the dashboard currency and date range', async () => {
    renderTile()
    await waitFor(() => expect(urls.length).toBeGreaterThan(0))
    expect(urls[0]).toContain('/api/summary/sankey')
    expect(urls[0]).toContain('currency=CAD')
    expect(urls[0]).toContain('dateFrom=2026-01-01')
    expect(urls[0]).toContain('dateTo=2026-09-27')
  })

  it('refetches when the dashboard range changes', async () => {
    const { rerender } = renderTile()
    await waitFor(() => expect(urls.length).toBe(1))
    rerender(
      <MemoryRouter>
        <CashflowSankeyTile currency="CAD" dateFrom="2026-02-01" dateTo="2026-02-28" />
      </MemoryRouter>,
    )
    await waitFor(() => expect(urls.length).toBe(2))
    expect(urls[1]).toContain('dateFrom=2026-02-01')
  })

  it('renders the shared chart with the inherited currency', async () => {
    renderTile()
    await waitFor(() =>
      expect(screen.getByTestId('sankey-chart')).toHaveAttribute('data-currency', 'CAD'),
    )
  })

  it('grows no range or currency controls of its own', async () => {
    renderTile()
    await waitFor(() => expect(screen.getByTestId('sankey-chart')).toBeInTheDocument())
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/currency/i)).not.toBeInTheDocument()
    // No quick-range chips — the dashboard's filter bar is the only control.
    for (const label of ['Last 30 days', 'Year to date', 'All time']) {
      expect(screen.queryByText(label)).not.toBeInTheDocument()
    }
  })

  it('links through to the full Cashflow page', async () => {
    renderTile()
    await waitFor(() => expect(screen.getByTestId('sankey-chart')).toBeInTheDocument())
    const link = screen.getByRole('link', { name: /full chart/i })
    expect(link).toHaveAttribute('href', '/reports/cashflow')
  })

  it('shows the empty state rather than an empty chart when there are no flows', async () => {
    mockFetch({ ...PAYLOAD, totalIncome: 0, totalSpend: 0, surplus: 0, nodes: [], links: [] })
    renderTile()
    await waitFor(() =>
      expect(screen.getByText(/no flows in this period/i)).toBeInTheDocument(),
    )
    expect(screen.queryByTestId('sankey-chart')).not.toBeInTheDocument()
  })

  it('surfaces a fetch failure instead of rendering a blank tile', async () => {
    mockFetch({ error: 'boom' }, false)
    renderTile()
    await waitFor(() =>
      expect(screen.getByText(/cashflow chart unavailable/i)).toBeInTheDocument(),
    )
  })
})
