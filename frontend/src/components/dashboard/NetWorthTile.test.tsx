import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { NetWorthTile } from './NetWorthTile'

const creditUtilizationMock = vi.fn(() => ({
  data: [] as Array<{
    currency: string
    utilizationPct: number
    cardCount: number
    totalBalance: number
    totalLimit: number
    byCard: never[]
  }>,
  loading: false,
  error: null,
  refresh: () => {},
}))

vi.mock('@/hooks/useNetWorth', () => ({
  useNetWorthCurrent: () => ({
    data: {
      asOf: '2026-05-24',
      baseCurrency: 'CAD',
      total: 12345,
      assetsTotal: 13000,
      liabilitiesTotal: -655,
      breakdown: { assets: [], liabilities: [] },
      fxRatesUsed: [],
      partial: false,
      gaps: [],
    },
    loading: false,
    error: null,
    refresh: () => {},
  }),
  useNetWorthSeries: () => ({
    data: {
      baseCurrency: 'CAD',
      granularity: 'monthly',
      points: [
        { date: '2025-06-30', total: 10000, assetsTotal: 10000, liabilitiesTotal: 0 },
        { date: '2026-05-31', total: 12345, assetsTotal: 13000, liabilitiesTotal: -655 },
      ],
      partial: false,
      gaps: [],
    },
    loading: false,
    error: null,
    refresh: () => {},
  }),
  useCreditUtilization: () => creditUtilizationMock(),
}))

describe('NetWorthTile', () => {
  it('renders headline figure and click-through to /net-worth', () => {
    creditUtilizationMock.mockReturnValueOnce({
      data: [],
      loading: false,
      error: null,
      refresh: () => {},
    })
    render(
      <MemoryRouter>
        <NetWorthTile />
      </MemoryRouter>,
    )
    expect(screen.getByText(/12,345/)).toBeInTheDocument()
    const link = screen.getByRole('link')
    expect(link).toHaveAttribute('href', '/net-worth')
  })

  it('renders per-currency credit utilization lines when present (#437)', () => {
    creditUtilizationMock.mockReturnValueOnce({
      data: [
        {
          currency: 'CAD',
          utilizationPct: 28,
          cardCount: 3,
          totalBalance: 840,
          totalLimit: 3000,
          byCard: [],
        },
        {
          currency: 'USD',
          utilizationPct: 78,
          cardCount: 1,
          totalBalance: 780,
          totalLimit: 1000,
          byCard: [],
        },
      ],
      loading: false,
      error: null,
      refresh: () => {},
    })
    render(
      <MemoryRouter>
        <NetWorthTile />
      </MemoryRouter>,
    )
    expect(screen.getByText(/Credit utilization: 28% across 3 cards \(CAD\)/)).toBeInTheDocument()
    expect(screen.getByText(/Credit utilization: 78% across 1 card \(USD\)/)).toBeInTheDocument()
  })

  it('omits credit utilization line when no eligible cards exist', () => {
    creditUtilizationMock.mockReturnValueOnce({
      data: [],
      loading: false,
      error: null,
      refresh: () => {},
    })
    render(
      <MemoryRouter>
        <NetWorthTile />
      </MemoryRouter>,
    )
    expect(screen.queryByText(/Credit utilization/)).not.toBeInTheDocument()
  })
})
