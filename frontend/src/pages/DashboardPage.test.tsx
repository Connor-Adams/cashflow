import React from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
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

const EMPTY_DASH = {
  byCategory: [],
  metricsByCurrency: [],
  monthlyByCurrency: [],
  netSpendByBusiness: [],
  categoryReports: [],
  merchantSummaries: [],
  accountSummaries: [],
  reviewQueue: [],
  categoryTree: [],
}

function insightRow(currency: string) {
  return {
    currency,
    netSpend: 100,
    realCost: 100,
    owedBack: 0,
    owedBackBreakdown: { reimbursable: 0, partnerShare: 0 },
    peerLending: { lent: 0, received: 0 },
    totalSpend: 100,
    totalCredits: 0,
    totalIncome: 0,
    totalPayments: 0,
  }
}

/** Dashboard payload with the same category/month/business rows in CAD and USD. */
function twoCurrencyDash(currencies: string[]) {
  return {
    ...EMPTY_DASH,
    byCategory: currencies.map((currency, i) => ({
      currency,
      category: 'Groceries',
      sumAmount: -(100 + i * 23),
      finalBusiness: false,
      finalSplitType: 'personal',
    })),
    metricsByCurrency: currencies.map((currency) => ({
      currency,
      totalSpend: 100,
      totalCredits: 0,
      totalPayments: 0,
      totalIncome: 50,
      netSpend: 100,
      transactionCount: 3,
    })),
    monthlyByCurrency: currencies.map((currency) => ({
      month: '2026-10',
      currency,
      totalSpend: 100,
      totalCredits: 0,
      totalPayments: 0,
      totalIncome: 50,
      netSpend: 100,
    })),
    netSpendByBusiness: currencies.map((currency) => ({
      currency,
      business: false,
      totalSpend: 100,
      totalCredits: 0,
      netSpend: 100,
      income: 50,
    })),
  }
}

function withPayloads(dash: unknown, insight: unknown) {
  const original = vi.mocked(getJson).getMockImplementation()!
  vi.mocked(getJson).mockImplementation(((path: string) => {
    if (path.startsWith('/api/summary/dashboard')) return Promise.resolve(dash)
    if (path.startsWith('/api/summary/period-insight')) return Promise.resolve(insight)
    return original(path)
  }) as typeof getJson)
  return () => vi.mocked(getJson).mockImplementation(original)
}

describe('DashboardPage comparison window', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
    // Local noon on Oct 17 — "This month" is Oct 1..Oct 31 but only 17 days
    // of it have happened.
    vi.useFakeTimers({ now: new Date(2026, 9, 17, 12), toFake: ['Date'] })
    vi.mocked(getJson).mockClear()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('compares This month to date against the same days of last month', async () => {
    await renderPage()
    await waitFor(() => {
      const paths = vi.mocked(getJson).mock.calls.map(([p]) => String(p))
      expect(paths).toContain(
        '/api/summary/dashboard?currency=CAD&dateFrom=2026-09-01&dateTo=2026-09-17',
      )
    })
    const paths = vi.mocked(getJson).mock.calls.map(([p]) => String(p))
    // The selected range itself is untouched.
    expect(paths).toContain(
      '/api/summary/dashboard?currency=CAD&dateFrom=2026-10-01&dateTo=2026-10-31',
    )
    // The old equal-day-span window is gone.
    expect(paths.some((p) => p.includes('dateFrom=2026-08-31'))).toBe(false)
  })
})

describe('DashboardPage with "All currencies" selected', () => {
  let restore: () => void = () => {}
  beforeEach(() => {
    window.sessionStorage.clear()
    window.sessionStorage.setItem('dashboard.currency', JSON.stringify(''))
  })
  afterEach(() => {
    restore()
    window.sessionStorage.clear()
  })

  it('never sums money across currencies — the money tiles ask for a currency', async () => {
    restore = withPayloads(twoCurrencyDash(['CAD', 'USD']), {
      byCurrency: [insightRow('CAD'), insightRow('USD')],
    })
    await renderPage()
    // Category chart, period band, income split, spend split, monthly flow.
    await waitFor(() => {
      expect(screen.getAllByText(/pick a currency to see/i)).toHaveLength(5)
    })
    // The category chart no longer renders a CAD+USD "Groceries" bar.
    expect(screen.queryByText('Groceries')).toBeNull()
    // The period band no longer silently shows the first currency.
    expect(screen.queryByText('Refunds / credits')).toBeNull()
    // Each notice offers the real currencies to pick from.
    expect(screen.getAllByRole('button', { name: 'Show USD' }).length).toBeGreaterThan(0)
  })

  it('renders the tiles normally when the data holds a single currency', async () => {
    restore = withPayloads(twoCurrencyDash(['USD']), {
      byCurrency: [insightRow('USD')],
    })
    await renderPage()
    expect(await screen.findByText('Groceries')).toBeInTheDocument()
    expect(screen.queryByText(/pick a currency to see/i)).toBeNull()
  })
})
