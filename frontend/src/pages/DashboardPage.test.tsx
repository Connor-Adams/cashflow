import React from 'react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ToastProvider } from '@/components/ui/toast'
import { getJson } from '@/lib/api'

// jsdom has no matchMedia; useIsNarrowViewport (via chartViewport) calls it on
// mount. Stub a non-matching media query so the page mounts in wide-viewport
// mode. Not a behavioral assertion — just enough to let the page render.
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  })
})

// Recharts + jsdom throws on zero-size ResponsiveContainer. Render its
// children in a fixed-size div so the charts mount without measuring.
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>()
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div style={{ width: 600, height: 300 }}>{children}</div>
    ),
  }
})

// Route-aware mock of the shared api client. DashboardPage and its child
// tiles all funnel through getJson; we pattern-match the path and return a
// minimal valid shape per endpoint (empty arrays where lists are expected)
// so the page renders its shell/empty states without throwing. Unknown
// endpoints fall through to [] (safe default, mirrors the tile tests).
vi.mock('@/lib/api', () => {
  // Prefix → minimal valid payload. No prefix here is a prefix of another, so
  // first match is the only match; order is presentational.
  const payloads: Array<[string, unknown]> = [
    [
      '/api/summary/dashboard',
      {
        byCategory: [],
        metricsByCurrency: [],
        monthlyByCurrency: [],
        netSpendByBusiness: [],
        categoryReports: [],
        merchantSummaries: [],
        accountSummaries: [],
        reviewQueue: [],
        categoryTree: [],
      },
    ],
    [
      '/api/summary/sankey',
      {
        currency: 'CAD',
        totalIncome: 0,
        totalSpend: 0,
        surplus: 0,
        balanced: true,
        transactionCount: 0,
        nodes: [],
        links: [],
        availableCurrencies: ['CAD'],
        dateRange: { from: null, to: null },
      },
    ],
    ['/api/summary/monthly', { points: [] }],
    ['/api/summary/period-insight', { byCurrency: [] }],
    ['/api/budgets/progress', { items: [] }],
    ['/api/budgets/status', { items: [] }],
    ['/api/recurring', { items: [] }],
    ['/api/insights', { data: [] }],
    [
      // ActivationCardDeck reads dismissedCards (array) + boolean flags.
      // An all-satisfied state makes the deck render nothing.
      '/api/activation-state',
      {
        hasAccounts: true,
        unreviewedCount: 0,
        hasBudget: true,
        hasGoal: true,
        hasOutboundInvite: true,
        dismissedCards: [],
      },
    ],
  ]

  return {
    getJson: vi.fn((path: string) => {
      const match = payloads.find(([prefix]) => path.startsWith(prefix))
      // Catch-all for the self-fetching tiles (safe-to-spend, net worth,
      // email status, etc.). They consume their data through useFetch, which
      // turns a rejection into { data: null, error } — every tile renders its
      // own empty/error/loading shell from that, so a reject is the safest
      // generic default (an empty array would be a truthy wrong-shaped payload
      // that tiles like SafeToSpendTile dereference and crash on).
      if (!match) return Promise.reject(new Error(`unmocked endpoint: ${path}`))
      return Promise.resolve(match[1])
    }),
    postJson: vi.fn(() => Promise.resolve({})),
    patchJson: vi.fn(() => Promise.resolve({})),
    deleteReq: vi.fn(() => Promise.resolve(undefined)),
  }
})

async function renderPage() {
  const { DashboardPage } = await import('./DashboardPage')
  return render(
    <MemoryRouter>
      <ToastProvider>
        <DashboardPage />
      </ToastProvider>
    </MemoryRouter>,
  )
}

describe('DashboardPage (characterization)', () => {
  it('renders the page heading', async () => {
    await renderPage()
    expect(
      await screen.findByRole('heading', { name: /^dashboard$/i, level: 1 }),
    ).toBeInTheDocument()
  })

  it('renders the filter caption and a section tile label', async () => {
    await renderPage()
    // The filter card caption always renders the active-scope chip.
    expect(await screen.findByText(/showing/i)).toBeInTheDocument()
    // "Net spend by category" is an always-rendered BentoTile label
    // (the tile shell renders regardless of whether there is data).
    expect(
      await screen.findByText(/net spend by category/i),
    ).toBeInTheDocument()
  })

  // 2026-09-27 full-chain spec, section 4: the Sankey lives on the homepage
  // and links through to the full page.
  it('renders the Cashflow Sankey tile with a link through to the full page', async () => {
    await renderPage()
    expect(await screen.findByText(/where the money went/i)).toBeInTheDocument()
    const link = await screen.findByRole('link', { name: /full chart/i })
    expect(link).toHaveAttribute('href', '/reports/cashflow')
  })

  it('renders skeletons while loading', async () => {
    // Pin loading=true by making getJson never resolve. Set the impl just for
    // this test and restore the route-aware default afterward so the sibling
    // tests above still see resolved data.
    const original = vi.mocked(getJson).getMockImplementation()
    vi.mocked(getJson).mockImplementation(() => new Promise(() => {}))
    try {
      const { container } = await renderPage()
      expect(
        container.querySelectorAll('[data-slot="skeleton"]').length,
      ).toBeGreaterThan(0)
    } finally {
      vi.mocked(getJson).mockImplementation(original!)
    }
  })
})
