import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { PortfolioSecurityPage } from './PortfolioSecurityPage'
import * as api from '../lib/api'
import { _resetAppConfigForTest } from '../lib/appConfig'

const baseDetail = {
  security: { id: 1, symbol: 'XEQT.TO', name: 'iShares', assetType: 'ETF', currency: 'CAD' },
  perAccount: [],
  combined: {
    currentQuantity: 10, currentMarketValue: 350, currentCostBasis: 300,
    realizedTotal: 0, income: { dividend: 5, interest: 0 }, currency: 'CAD',
  },
  activities: [],
  holdings: [],
  latestPrice: null,
}

const baseOverview = {
  securityId: 1, sector: 'Diversified', industry: null, country: 'Canada',
  exchange: 'TSX', description: null, metadataFetchedAt: '2026-05-24T00:00:00.000Z',
  backfill: { status: 'fresh', lastFetchedAt: null, nextRetryAt: null, coverageDays: 1 },
}

const basePrices = {
  securityId: 1, symbol: 'XEQT.TO', currency: 'CAD', range: '1y', rows: [], trades: [],
  backfill: { status: 'fresh', lastFetchedAt: null, nextRetryAt: null, coverageDays: 0 },
}

const baseDivs = {
  securityId: 1, currency: 'CAD', events: [],
  backfill: { status: 'fresh', lastFetchedAt: null, nextRetryAt: null, coverageDays: 0 },
}

function mockApi(mapping: Record<string, unknown>) {
  vi.spyOn(api, 'getJson').mockImplementation(async (url: string) => {
    for (const [k, v] of Object.entries(mapping)) {
      if (url.startsWith(k)) return v as never
    }
    throw new Error(`unmocked ${url}`)
  })
}

describe('PortfolioSecurityPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    _resetAppConfigForTest()
    window.__APP_CONFIG__ = { logoDevToken: null, quoteProviderConfigured: true }
  })

  it('renders header + cards on happy path', async () => {
    mockApi({
      '/api/portfolio/security/1/overview': baseOverview,
      '/api/portfolio/security/1/prices': basePrices,
      '/api/portfolio/security/1/dividends': baseDivs,
      '/api/portfolio/security/1': baseDetail,
    })
    const { findByText } = render(
      <MemoryRouter initialEntries={['/portfolio/security/1']}>
        <Routes>
          <Route path="/portfolio/security/:id" element={<PortfolioSecurityPage />} />
        </Routes>
      </MemoryRouter>,
    )
    expect(await findByText('XEQT.TO')).not.toBeNull()
    expect(await findByText('Quantity')).not.toBeNull()
    expect(await findByText('Price history')).not.toBeNull()
    expect(await findByText('Dividend history')).not.toBeNull()
    expect(await findByText('About')).not.toBeNull()
  })

  it('renders without crashing when overview fetch fails', async () => {
    vi.spyOn(api, 'getJson').mockImplementation(async (url: string) => {
      if (url.includes('/overview')) throw new Error('AV not configured')
      if (url.endsWith('/api/portfolio/security/1')) return baseDetail as never
      if (url.includes('/prices')) return basePrices as never
      if (url.includes('/dividends')) return baseDivs as never
      throw new Error(`unmocked ${url}`)
    })
    const { findByText } = render(
      <MemoryRouter initialEntries={['/portfolio/security/1']}>
        <Routes>
          <Route path="/portfolio/security/:id" element={<PortfolioSecurityPage />} />
        </Routes>
      </MemoryRouter>,
    )
    expect(await findByText(/No company info/i)).not.toBeNull()
  })
})
