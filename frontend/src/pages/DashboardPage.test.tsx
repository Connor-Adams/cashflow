import React from 'react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ToastProvider } from '@/components/ui/toast'

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
vi.mock('@/lib/api', () => ({
  getJson: vi.fn((path: string) => {
    if (path.startsWith('/api/summary/dashboard')) {
      return Promise.resolve({
        byCategory: [],
        metricsByCurrency: [],
        monthlyByCurrency: [],
        netSpendByBusiness: [],
        categoryReports: [],
        merchantSummaries: [],
        accountSummaries: [],
        reviewQueue: [],
        categoryTree: [],
      })
    }
    if (path.startsWith('/api/summary/monthly')) {
      return Promise.resolve({ points: [] })
    }
    if (path.startsWith('/api/summary/period-insight')) {
      return Promise.resolve({ byCurrency: [] })
    }
    if (path.startsWith('/api/budgets/progress')) {
      return Promise.resolve({ items: [] })
    }
    if (path.startsWith('/api/budgets/status')) {
      return Promise.resolve({ items: [] })
    }
    if (path.startsWith('/api/recurring')) {
      return Promise.resolve({ items: [] })
    }
    if (path.startsWith('/api/insights')) {
      return Promise.resolve({ data: [] })
    }
    if (path.startsWith('/api/activation-state')) {
      // ActivationCardDeck reads dismissedCards (array) + boolean flags.
      // Return an all-satisfied state so the deck renders nothing.
      return Promise.resolve({
        hasAccounts: true,
        unreviewedCount: 0,
        hasBudget: true,
        hasGoal: true,
        hasOutboundInvite: true,
        dismissedCards: [],
      })
    }
    // Catch-all for the self-fetching tiles (safe-to-spend, net worth,
    // email status, etc.). They consume their data through useFetch, which
    // turns a rejection into { data: null, error } — every tile renders its
    // own empty/error/loading shell from that, so a reject is the safest
    // generic default (an empty array would be a truthy wrong-shaped payload
    // that tiles like SafeToSpendTile dereference and crash on).
    return Promise.reject(new Error(`unmocked endpoint: ${path}`))
  }),
  postJson: vi.fn(() => Promise.resolve({})),
  patchJson: vi.fn(() => Promise.resolve({})),
  deleteReq: vi.fn(() => Promise.resolve(undefined)),
}))

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
    // The FilterCard caption always renders the active-scope chip.
    expect(await screen.findByText(/showing/i)).toBeInTheDocument()
    // "Net spend by category" is an always-rendered BentoTile label
    // (the tile shell renders regardless of whether there is data).
    expect(
      await screen.findByText(/net spend by category/i),
    ).toBeInTheDocument()
  })
})
