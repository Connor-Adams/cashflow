import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor, fireEvent } from '@testing-library/react'
import { PriceChartCard } from './PriceChartCard'
import * as api from '../../lib/api'
import { _resetAppConfigForTest } from '../../lib/appConfig'

describe('PriceChartCard', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    _resetAppConfigForTest()
    window.__APP_CONFIG__ = { logoDevToken: null, quoteProviderConfigured: true }
  })

  it('fetches 1y range by default and renders chart', async () => {
    const spy = vi.spyOn(api, 'getJson').mockResolvedValue({
      securityId: 1, symbol: 'X', currency: 'CAD', range: '1y',
      rows: [
        { date: '2025-05-24', open: null, high: null, low: null, close: 30, adjClose: 30, volume: null },
        { date: '2026-05-24', open: null, high: null, low: null, close: 35, adjClose: 35, volume: null },
      ],
      trades: [],
      backfill: { status: 'fresh', lastFetchedAt: null, nextRetryAt: null, coverageDays: 365 },
    })
    const { container } = render(<PriceChartCard securityId={1} currency="CAD" />)
    await waitFor(() => expect(spy).toHaveBeenCalledWith('/api/portfolio/security/1/prices?range=1y'))
    await waitFor(() => expect(container.querySelector('svg')).not.toBeNull())
  })

  it('refetches when range changes', async () => {
    const spy = vi.spyOn(api, 'getJson').mockResolvedValue({
      securityId: 1, symbol: 'X', currency: 'CAD', range: '1y', rows: [], trades: [],
      backfill: { status: 'fresh', lastFetchedAt: null, nextRetryAt: null, coverageDays: 0 },
    })
    const { getByText } = render(<PriceChartCard securityId={1} currency="CAD" />)
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
    fireEvent.click(getByText('1M'))
    await waitFor(() => expect(spy).toHaveBeenCalledWith('/api/portfolio/security/1/prices?range=1m'))
  })

  it('shows history-loading banner when backfill status is never', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValue({
      securityId: 1, symbol: 'X', currency: 'CAD', range: '1y', rows: [], trades: [],
      backfill: { status: 'never', lastFetchedAt: null, nextRetryAt: null, coverageDays: 0 },
    })
    const { findByText } = render(<PriceChartCard securityId={1} currency="CAD" />)
    expect(await findByText(/History loading/i)).not.toBeNull()
  })

  it('shows rate-limited banner with literal "midnight UTC" phrasing (AC10)', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValue({
      securityId: 1, symbol: 'X', currency: 'CAD', range: '1y', rows: [], trades: [],
      backfill: { status: 'rate_limited', lastFetchedAt: null, nextRetryAt: '2026-05-25T00:00:00.000Z', coverageDays: 0 },
    })
    const { findByText, container } = render(<PriceChartCard securityId={1} currency="CAD" />)
    expect(await findByText(/quota exhausted/i)).not.toBeNull()
    // Spec AC10: literal phrase, not locale-formatted datetime.
    expect(container.textContent).toContain('retry after midnight UTC')
  })

  it('shows config-prompt placeholder when AV key is unset (AC7) and does NOT fetch', async () => {
    window.__APP_CONFIG__ = { logoDevToken: null, quoteProviderConfigured: false }
    const spy = vi.spyOn(api, 'getJson')
    const { findByText } = render(<PriceChartCard securityId={1} currency="CAD" />)
    expect(await findByText(/ALPHA_VANTAGE_API_KEY/i)).not.toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })
})
