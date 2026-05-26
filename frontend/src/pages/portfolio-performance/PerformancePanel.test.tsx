import React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { PerformancePanel } from './PerformancePanel'
import * as api from '../../lib/api'

const mockData = {
  range: '1Y' as const,
  stats: { twrPct: 5.5, mwrPct: 6.1, benchmarkTwrPct: 4.0, vsBenchmarkDeltaPct: 1.5, startDate: '2025-05-25', endDate: '2026-05-25', startValueCad: 1000, endValueCad: 1055, netCashFlowCad: 0 },
  presetStats: {
    '1M': { twrPct: 1.5, mwrPct: 1.8, benchmarkTwrPct: 1.0, vsBenchmarkDeltaPct: 0.5, startDate: '2026-04-25', endDate: '2026-05-25', startValueCad: 1040, endValueCad: 1055, netCashFlowCad: 0 },
    '3M': { twrPct: 2.5, mwrPct: 2.8, benchmarkTwrPct: 2.0, vsBenchmarkDeltaPct: 0.5, startDate: '2026-02-25', endDate: '2026-05-25', startValueCad: 1030, endValueCad: 1055, netCashFlowCad: 0 },
    'YTD': { twrPct: 3.0, mwrPct: 3.2, benchmarkTwrPct: 2.5, vsBenchmarkDeltaPct: 0.5, startDate: '2026-01-01', endDate: '2026-05-25', startValueCad: 1025, endValueCad: 1055, netCashFlowCad: 0 },
    '1Y': { twrPct: 5.5, mwrPct: 6.1, benchmarkTwrPct: 4.0, vsBenchmarkDeltaPct: 1.5, startDate: '2025-05-25', endDate: '2026-05-25', startValueCad: 1000, endValueCad: 1055, netCashFlowCad: 0 },
    'All': { twrPct: 8.0, mwrPct: 8.5, benchmarkTwrPct: 7.0, vsBenchmarkDeltaPct: 1.0, startDate: '2023-01-01', endDate: '2026-05-25', startValueCad: 977, endValueCad: 1055, netCashFlowCad: 0 },
  },
  series: [{ date: '2026-01-01', portfolioValueCad: 1000, benchmarkValueCad: 1000, isPartial: false }],
  byAccount: [{ accountId: 1, accountName: 'TFSA', twrPct: 5.5, endValueCad: 1055, weightInPortfolioPct: 100 }],
  caveats: { partialDaysCount: 0, missingDataReasons: [], benchmarkSymbol: 'SPY', benchmarkIsPartial: false },
}

describe('PerformancePanel', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('shows loading then data', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValueOnce(mockData)
    render(<MemoryRouter><PerformancePanel /></MemoryRouter>)
    expect(screen.getByText(/Loading/i)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText(/TFSA/)).toBeInTheDocument())
  })

  it('error path', async () => {
    vi.spyOn(api, 'getJson').mockRejectedValueOnce(new Error('boom'))
    render(<MemoryRouter><PerformancePanel /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument())
  })

  it('refetches on range change', async () => {
    const spy = vi.spyOn(api, 'getJson').mockResolvedValue(mockData)
    render(<MemoryRouter><PerformancePanel /></MemoryRouter>)
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: '1M' }))
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2))
  })
})
