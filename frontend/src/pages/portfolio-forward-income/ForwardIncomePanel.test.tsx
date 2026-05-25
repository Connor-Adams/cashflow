import React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ForwardIncomePanel } from './ForwardIncomePanel'
import * as api from '../../lib/api'

const mockData = {
  totals: {
    projectedAnnualIncomeCad: 120,
    projectedAnnualIncomeByCurrency: [{ currency: 'CAD', amount: 120 }],
    forwardYieldPct: 2.4,
    forwardYieldOnCostPct: 2.67,
    computedAt: '2026-05-25T10:00:00Z',
    fxRateUsedAt: '2026-05-25T10:00:00Z',
  },
  rows: [{
    securityId: 1, symbol: 'VCN', name: 'Vanguard Canada', assetType: 'etf',
    currency: 'CAD', qty: 100, currentMvNative: 5000, costBasisNative: 4500,
    annualDividendPerShare: 1.2, annualInterestPerShare: 0,
    projectedAnnualIncomeNative: 120, projectedAnnualIncomeCad: 120,
    forwardYieldPct: 2.4, forwardYieldOnCostPct: 2.67,
    cadenceLabel: 'monthly' as const, cvPct: 0.1, unreliable: false,
    nextExDivDates: [],
  }],
  byTaxStatus: [{ taxStatus: 'non_registered' as const, byCurrency: [{ currency: 'CAD', amount: 120 }], totalCad: 120 }],
  byAssetType: [{ assetType: 'etf', byCurrency: [{ currency: 'CAD', amount: 120 }], totalCad: 120 }],
  upcoming90d: [],
  caveats: { unreliableSecurityIds: [], holdingsWithoutHistory: [] },
}

describe('ForwardIncomePanel', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('shows loading then renders data', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValueOnce(mockData)
    render(<MemoryRouter><ForwardIncomePanel /></MemoryRouter>)
    expect(screen.getByText(/Loading/i)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('VCN')).toBeInTheDocument())
  })

  it('shows error', async () => {
    vi.spyOn(api, 'getJson').mockRejectedValueOnce(new Error('boom'))
    render(<MemoryRouter><ForwardIncomePanel /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument())
  })

  it('renders empty state when no rows', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValueOnce({ ...mockData, rows: [] })
    render(<MemoryRouter><ForwardIncomePanel /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText(/no income-generating holdings/i)).toBeInTheDocument())
  })
})
