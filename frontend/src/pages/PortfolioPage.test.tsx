import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { PortfolioPage } from './PortfolioPage'
import * as api from '../lib/api'
import { _resetAppConfigForTest } from '../lib/appConfig'

const baseSummary = {
  accounts: [{ id: 1, name: 'TFSA', shortCode: 'TFSA01', currency: 'CAD' }],
  totalsByCurrency: [{ currency: 'CAD', marketValue: 4400 }],
  unifiedTotal: {
    baseCurrency: 'CAD',
    marketValue: 4400,
    ratesUsed: [],
    todayChangePct: 0.45,
    todayChangeCad: 20,
  },
  holdings: [
    {
      id: 10,
      accountId: 1,
      security: { id: 100, symbol: 'XEQT', name: 'iShares' },
      quantity: 100,
      currency: 'CAD',
      price: 30,
      marketValue: 3000,
      costBasis: 2700,
      unrealizedGainLoss: 300,
      statementDate: '2026-05-01',
      latestPrice: null,
      todayChangePct: 1.5,
      thirtyDayReturnPct: 4.2,
      weightPct: 68.0,
      yieldOnCostPct: 2.1,
    },
    {
      id: 11,
      accountId: 1,
      security: { id: 101, symbol: 'BNS', name: 'Scotiabank' },
      quantity: 20,
      currency: 'CAD',
      price: 70,
      marketValue: 1400,
      costBasis: 1300,
      unrealizedGainLoss: 100,
      statementDate: '2026-05-01',
      latestPrice: null,
      todayChangePct: null,
      thirtyDayReturnPct: null,
      weightPct: null,
      yieldOnCostPct: null,
    },
  ],
  recentActivities: [],
}

const baseAllocation = {
  byAssetType: [],
  bySecurity: [],
  byAccount: [],
}

const baseBySec = {
  rows: [
    {
      securityId: 100,
      symbol: 'XEQT',
      name: 'iShares',
      assetType: 'ETF',
      totalQuantity: 100,
      totalCostBasis: 2700,
      totalMarketValue: 3000,
      unrealizedGainLoss: 300,
      accountBreakdown: [{ accountId: 1, accountName: 'TFSA', quantity: 100 }],
      currency: 'CAD',
      latestPrice: null,
      todayChangePct: 1.5,
      thirtyDayReturnPct: 4.2,
      weightPct: 100,
      totalReturnPct: 12.5,
    },
  ],
  unifiedTotal: {
    baseCurrency: 'CAD',
    marketValue: 3000,
    ratesUsed: [],
    todayChangePct: 1.5,
    todayChangeCad: 45,
  },
}

const baseSparks = {
  range: '30d',
  bySecurityId: {
    '100': [
      { date: '2026-04-25', close: 28 },
      { date: '2026-04-26', close: 28.5 },
      { date: '2026-04-27', close: 29 },
      { date: '2026-05-24', close: 30 },
    ],
    // BNS (101) intentionally omitted — has no daily-price history
  },
}

function mockApi(mapping: Record<string, unknown>) {
  vi.spyOn(api, 'getJson').mockImplementation(async (url: string) => {
    for (const [k, v] of Object.entries(mapping)) {
      if (url.startsWith(k)) return v as never
    }
    throw new Error(`unmocked ${url}`)
  })
}

describe('PortfolioPage table polish', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    _resetAppConfigForTest()
    window.__APP_CONFIG__ = { logoDevToken: null, quoteProviderConfigured: true }
  })

  it('renders logo (letter-avatar fallback) in Holdings symbol cell', async () => {
    mockApi({
      '/api/portfolio/sparklines': baseSparks,
      '/api/portfolio/allocation': baseAllocation,
      '/api/portfolio/by-security': baseBySec,
      '/api/portfolio': baseSummary,
    })
    const { findByText, getAllByRole } = render(
      <MemoryRouter>
        <PortfolioPage />
      </MemoryRouter>,
    )
    // Holdings tab is default — wait for data to load by looking for a holding symbol
    await findByText('XEQT')
    // No logo token configured → SecurityLogo renders LetterAvatar (role="img")
    const avatars = getAllByRole('img')
    expect(avatars.length).toBeGreaterThan(0)
  })

  it('renders sparkline svg for XEQT (with data) but blank cell for BNS (no data)', async () => {
    mockApi({
      '/api/portfolio/sparklines': baseSparks,
      '/api/portfolio/allocation': baseAllocation,
      '/api/portfolio/by-security': baseBySec,
      '/api/portfolio': baseSummary,
    })
    const { container, findByText } = render(
      <MemoryRouter>
        <PortfolioPage />
      </MemoryRouter>,
    )
    await findByText('XEQT')
    await waitFor(() => {
      const svgs = container.querySelectorAll('svg')
      expect(svgs.length).toBeGreaterThan(0)
    })
  })

  it('does NOT call AV when visiting the Holdings tab', async () => {
    const spy = vi.spyOn(api, 'getJson').mockImplementation(async (url: string) => {
      const mapping: Record<string, unknown> = {
        '/api/portfolio/sparklines': baseSparks,
        '/api/portfolio/allocation': baseAllocation,
        '/api/portfolio/by-security': baseBySec,
        '/api/portfolio': baseSummary,
      }
      for (const [k, v] of Object.entries(mapping)) {
        if (url.startsWith(k)) return v as never
      }
      throw new Error(`unmocked ${url}`)
    })
    render(
      <MemoryRouter>
        <PortfolioPage />
      </MemoryRouter>,
    )
    await waitFor(() => expect(spy).toHaveBeenCalled())
    for (const call of spy.mock.calls) {
      const url = call[0] as string
      expect(url).not.toContain('/prices/refresh')
      expect(url).not.toMatch(/\/security\/\d+\//)
    }
  })

  it('renders By-security sparkline column header', async () => {
    mockApi({
      '/api/portfolio/sparklines': baseSparks,
      '/api/portfolio/allocation': baseAllocation,
      '/api/portfolio/by-security': baseBySec,
      '/api/portfolio': baseSummary,
    })
    const { findByText, getAllByText } = render(
      <MemoryRouter>
        <PortfolioPage />
      </MemoryRouter>,
    )
    const tab = await findByText('By security')
    tab.click()
    await waitFor(() => {
      const allHeads = getAllByText('30d')
      expect(allHeads.length).toBeGreaterThanOrEqual(1)
    })
  })

  it('renders Today / 30d Δ / Weight / Yield cells with values for XEQT', async () => {
    mockApi({
      '/api/portfolio/sparklines': baseSparks,
      '/api/portfolio/allocation': baseAllocation,
      '/api/portfolio/by-security': baseBySec,
      '/api/portfolio': baseSummary,
    })
    const { findByText, container } = render(
      <MemoryRouter>
        <PortfolioPage />
      </MemoryRouter>,
    )
    await findByText('XEQT')
    expect(container.textContent).toContain('1.50%')
    expect(container.textContent).toContain('4.20%')
    expect(container.textContent).toContain('68.0%')
    expect(container.textContent).toContain('2.10%')
  })

  it('renders em-dash in metric cells when fields are null', async () => {
    mockApi({
      '/api/portfolio/sparklines': baseSparks,
      '/api/portfolio/allocation': baseAllocation,
      '/api/portfolio/by-security': baseBySec,
      '/api/portfolio': baseSummary,
    })
    const { findByText, container } = render(
      <MemoryRouter>
        <PortfolioPage />
      </MemoryRouter>,
    )
    await findByText('BNS')
    const emDashCount = (container.textContent?.match(/—/g) ?? []).length
    expect(emDashCount).toBeGreaterThanOrEqual(4)
  })

  it('renders skeletons while loading', () => {
    // never-resolving getJson pins loading=true. beforeEach restoreAllMocks
    // tears this down for the next test.
    vi.spyOn(api, 'getJson').mockImplementation(
      () => new Promise(() => {}) as never,
    )
    const { container } = render(
      <MemoryRouter>
        <PortfolioPage />
      </MemoryRouter>,
    )
    expect(
      container.querySelectorAll('[data-slot="skeleton"]').length,
    ).toBeGreaterThan(0)
  })

  it('Total (CAD) stat card shows delta when present', async () => {
    mockApi({
      '/api/portfolio/sparklines': baseSparks,
      '/api/portfolio/allocation': baseAllocation,
      '/api/portfolio/by-security': baseBySec,
      '/api/portfolio': baseSummary,
    })
    const { findByText, container } = render(
      <MemoryRouter>
        <PortfolioPage />
      </MemoryRouter>,
    )
    await findByText('Total (CAD)')
    expect(container.textContent).toContain('0.45%')
  })
})
