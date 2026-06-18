/**
 * Frontend tests for SankeyPage (issue #224).
 *
 * Covers the AC bullets that are observable from the page-level shell:
 *  - empty-state renders when the backend reports zero income+spend (AC 6)
 *  - currency picker is wired to the backend's `availableCurrencies`
 *  - the page renders the headline totals returned by the API
 *  - the drill-down dialog opens when a flow link is clicked and shows
 *    the source transactions from /sankey/source-transactions (AC 4)
 *
 * The recharts Sankey itself is rendered via jsdom-only stubs in this
 * suite — we mock the recharts barrel so the page's link-click handler
 * can be triggered without depending on layout pixel math.
 */
import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock recharts so we don't have to deal with SVG layout in jsdom. The
// component renders a fake "Sankey" that exposes one button per link;
// clicking it calls the `link` render prop with synthetic source/target
// payload values, which is exactly what the page wires up.
vi.mock('recharts', () => {
  type LinkPayload = {
    source: number | { index?: number; name?: string }
    target: number | { index?: number; name?: string }
    value: number
  }
  return {
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="responsive">{children}</div>
    ),
    Sankey: ({ data, link, node, children }: {
      data: { nodes: Array<{ name: string }>; links: LinkPayload[] }
      link: (props: unknown) => React.ReactElement
      node: (props: unknown) => React.ReactElement
      children?: React.ReactNode
    }) => (
      <div data-testid="sankey">
        {data.links.map((l, idx) => (
          <div key={idx} data-testid={`fake-link-${idx}`}>
            {link({
              payload: l,
              sourceX: 0,
              sourceY: 0,
              targetX: 0,
              targetY: 0,
              sourceControlX: 0,
              targetControlX: 0,
              linkWidth: 8,
              index: idx,
            })}
          </div>
        ))}
        {data.nodes.map((n, idx) => (
          <div key={idx} data-testid={`fake-node-${idx}`}>
            {node({
              payload: n,
              index: idx,
              x: 0,
              y: 0,
              width: 10,
              height: 20,
            })}
          </div>
        ))}
        {children}
      </div>
    ),
    Rectangle: (props: React.SVGProps<SVGRectElement>) => <rect {...props} />,
    Tooltip: () => null,
  }
})

import { SankeyPage } from './SankeyPage'

const SANKEY_PAYLOAD = {
  currency: 'CAD',
  totalIncome: 5000,
  totalSpend: 425,
  transactionCount: 4,
  nodes: [
    { name: 'Income', kind: 'income' as const },
    { name: 'Groceries', kind: 'category' as const },
    { name: 'Business spending', kind: 'business' as const },
  ],
  links: [
    { source: 0, target: 1, value: 225 },
    { source: 0, target: 2, value: 200 },
  ],
  availableCurrencies: ['CAD', 'USD'],
  dateRange: { from: null, to: null },
}

const DRILL_PAYLOAD = {
  edge: { source: 0, target: 1 },
  transactionCount: 2,
  truncated: false,
  transactions: [
    {
      id: 101,
      date: '2026-03-05',
      currency: 'CAD',
      amount: -150,
      merchant: 'Loblaws',
      finalCategory: 'Groceries',
      finalBusiness: false,
      txnType: 'purchase',
    },
    {
      id: 102,
      date: '2026-03-10',
      currency: 'CAD',
      amount: -75,
      merchant: 'Loblaws',
      finalCategory: 'Groceries',
      finalBusiness: false,
      txnType: 'purchase',
    },
  ],
}

const EMPTY_PAYLOAD = {
  currency: 'CAD',
  totalIncome: 0,
  totalSpend: 0,
  transactionCount: 0,
  nodes: [],
  links: [],
  availableCurrencies: ['CAD'],
  dateRange: { from: null, to: null },
}

function mockFetch(payloads: {
  sankey?: unknown
  drill?: unknown
} = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo) => {
      const url = String(input)
      if (url.includes('/api/summary/sankey/source-transactions')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: new Headers(),
          json: () => Promise.resolve(payloads.drill ?? DRILL_PAYLOAD),
          text: () =>
            Promise.resolve(JSON.stringify(payloads.drill ?? DRILL_PAYLOAD)),
        } as Response)
      }
      if (url.includes('/api/summary/sankey')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: new Headers(),
          json: () => Promise.resolve(payloads.sankey ?? SANKEY_PAYLOAD),
          text: () =>
            Promise.resolve(JSON.stringify(payloads.sankey ?? SANKEY_PAYLOAD)),
        } as Response)
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        json: () => Promise.resolve({}),
        text: () => Promise.resolve('{}'),
      } as Response)
    }),
  )
}

describe('SankeyPage', () => {
  beforeEach(() => {
    // Clear sessionStorage so the useSessionState hooks see fresh defaults.
    window.sessionStorage.clear()
    mockFetch()
  })

  it('renders the page header and headline totals', async () => {
    render(
      <MemoryRouter>
        <SankeyPage />
      </MemoryRouter>,
    )
    expect(screen.getByText('Cashflow')).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByText('Total income')).toBeInTheDocument(),
    )
    // Backend returned 5000 CAD income, 425 CAD spend.
    await waitFor(() => {
      const incomeCard = screen
        .getByText('Total income')
        .closest('[data-slot="stat-card"]')
      const spendCard = screen
        .getByText('Total spend')
        .closest('[data-slot="stat-card"]')
      expect(incomeCard?.textContent).toContain('5,000')
      expect(spendCard?.textContent).toContain('425')
    })
  })

  it('renders the empty state when totals are zero (AC: empty state clear)', async () => {
    mockFetch({ sankey: EMPTY_PAYLOAD })
    render(
      <MemoryRouter>
        <SankeyPage />
      </MemoryRouter>,
    )
    await waitFor(() =>
      expect(screen.getByText('No flows for this filter')).toBeInTheDocument(),
    )
  })

  it('opens drill-down dialog when a flow segment is clicked (AC: click for source txns)', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <SankeyPage />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByTestId('sankey')).toBeInTheDocument())
    // The mock Sankey renders one path per link with data-testid=sankey-link.
    // The first link is Income → Groceries.
    const links = screen.getAllByTestId('sankey-link')
    expect(links.length).toBe(2)
    await user.click(links[0])
    // Dialog opens, showing the seeded drill rows.
    await waitFor(() =>
      expect(screen.getByText('Income → Groceries')).toBeInTheDocument(),
    )
    expect(screen.getAllByText('Loblaws').length).toBeGreaterThan(0)
    expect(screen.getByText('2026-03-05')).toBeInTheDocument()
    expect(screen.getByText('2026-03-10')).toBeInTheDocument()
  })

  it('uses availableCurrencies for the currency picker', async () => {
    render(
      <MemoryRouter>
        <SankeyPage />
      </MemoryRouter>,
    )
    // FilterBar with availableCurrencies renders a <select>. CAD + USD show up.
    await waitFor(() => {
      const select = screen.getByLabelText(/currency/i)
      expect(select).toBeInTheDocument()
      expect((select as HTMLSelectElement).options.length).toBeGreaterThanOrEqual(2)
    })
  })
})
