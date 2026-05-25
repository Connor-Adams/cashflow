import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { NetWorthPage } from './NetWorthPage'
import { updateOpeningBalance } from '@/hooks/useNetWorth'

vi.mock('@/hooks/useNetWorth', () => ({
  useNetWorthCurrent: () => ({
    data: {
      asOf: '2026-05-24',
      baseCurrency: 'CAD',
      total: 152340.12,
      assetsTotal: 154440.12,
      liabilitiesTotal: -2100,
      breakdown: {
        assets: [
          {
            source: 'account',
            accountId: 1,
            label: 'Chq',
            currency: 'CAD',
            native: 5000,
            cadValue: 5000,
            openingBalanceSet: true,
          },
        ],
        liabilities: [
          {
            source: 'account',
            accountId: 7,
            label: 'Visa',
            currency: 'CAD',
            native: -2100,
            cadValue: -2100,
            openingBalanceSet: true,
          },
        ],
      },
      fxRatesUsed: [],
      partial: false,
      gaps: [],
    },
    loading: false,
    error: null,
    refresh: () => {},
  }),
  useNetWorthSeries: () => ({
    data: { baseCurrency: 'CAD', granularity: 'monthly', points: [], partial: false, gaps: [] },
    loading: false,
    error: null,
    refresh: () => {},
  }),
  updateOpeningBalance: vi.fn(),
}))

describe('NetWorthPage', () => {
  it('renders the headline figure', async () => {
    render(
      <MemoryRouter>
        <NetWorthPage />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText(/152,340/)).toBeInTheDocument())
  })

  it('renders rows for both assets and liabilities', async () => {
    render(
      <MemoryRouter>
        <NetWorthPage />
      </MemoryRouter>,
    )
    expect(await screen.findByText('Chq')).toBeInTheDocument()
    expect(screen.getByText('Visa')).toBeInTheDocument()
  })

  it('renders the range picker buttons', () => {
    render(
      <MemoryRouter>
        <NetWorthPage />
      </MemoryRouter>,
    )
    expect(screen.getByRole('button', { name: '1M' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '3M' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '1Y' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'All' })).toBeInTheDocument()
  })

  it('opening-balance editor PATCHes the new value on save', async () => {
    render(
      <MemoryRouter>
        <NetWorthPage />
      </MemoryRouter>,
    )
    const toggle = screen.getByRole('button', { name: /opening balances/i })
    await userEvent.click(toggle)
    const input = await screen.findByLabelText(/opening balance for chq/i)
    await userEvent.clear(input)
    await userEvent.type(input, '2500')
    await userEvent.click(screen.getByRole('button', { name: /save chq/i }))
    expect(updateOpeningBalance).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ openingBalance: 2500 }),
    )
  })
})
