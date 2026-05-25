import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { NetWorthTile } from './NetWorthTile'

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
}))

describe('NetWorthTile', () => {
  it('renders headline figure and click-through to /net-worth', () => {
    render(
      <MemoryRouter>
        <NetWorthTile />
      </MemoryRouter>,
    )
    expect(screen.getByText(/12,345/)).toBeInTheDocument()
    const link = screen.getByRole('link')
    expect(link).toHaveAttribute('href', '/net-worth')
  })
})
