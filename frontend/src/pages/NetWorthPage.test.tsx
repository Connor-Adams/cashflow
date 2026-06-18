import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { NetWorthPage } from './NetWorthPage'
import {
  updateOpeningBalance,
  useNetWorthCurrent,
  useNetWorthSeries,
} from '@/hooks/useNetWorth'

// Back the hook mocks with vi.fn so individual tests can override the return
// value (e.g. the loading-skeleton test) and restore the loaded default after.
const loadedCurrent = () => ({
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
})

const loadedSeries = () => ({
  data: { baseCurrency: 'CAD', granularity: 'monthly', points: [], partial: false, gaps: [] },
  loading: false,
  error: null,
  refresh: () => {},
})

vi.mock('@/hooks/useNetWorth', () => ({
  useNetWorthCurrent: vi.fn(() => loadedCurrent()),
  useNetWorthSeries: vi.fn(() => loadedSeries()),
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

  it('renders skeletons while loading', () => {
    // NetWorthPage shows its skeleton when current.loading && !current.data.
    // Override the hook for this test, then restore the loaded default so the
    // sibling tests above/below keep seeing real data.
    vi.mocked(useNetWorthCurrent).mockReturnValue({
      data: null,
      loading: true,
      error: null,
      refresh: () => {},
    })
    vi.mocked(useNetWorthSeries).mockReturnValue({
      data: null,
      loading: true,
      error: null,
      refresh: () => {},
    })
    try {
      const { container } = render(
        <MemoryRouter>
          <NetWorthPage />
        </MemoryRouter>,
      )
      expect(
        container.querySelectorAll('[data-slot="skeleton"]').length,
      ).toBeGreaterThan(0)
    } finally {
      vi.mocked(useNetWorthCurrent).mockImplementation(() => loadedCurrent())
      vi.mocked(useNetWorthSeries).mockImplementation(() => loadedSeries())
    }
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

  it('rejects a negative opening balance on an asset account', async () => {
    vi.mocked(updateOpeningBalance).mockClear()
    render(
      <MemoryRouter>
        <NetWorthPage />
      </MemoryRouter>,
    )
    await userEvent.click(screen.getByRole('button', { name: /opening balances/i }))
    const input = await screen.findByLabelText(/opening balance for chq/i)
    await userEvent.clear(input)
    await userEvent.type(input, '-100')
    await userEvent.click(screen.getByRole('button', { name: /save chq/i }))
    await waitFor(() =>
      expect(
        screen.getByText(/opening balance for an asset account can't be negative/i),
      ).toBeInTheDocument(),
    )
    expect(updateOpeningBalance).not.toHaveBeenCalled()
  })

  it('allows a negative opening balance on a non-asset (liability) account', async () => {
    vi.mocked(updateOpeningBalance).mockClear()
    render(
      <MemoryRouter>
        <NetWorthPage />
      </MemoryRouter>,
    )
    await userEvent.click(screen.getByRole('button', { name: /opening balances/i }))
    const input = await screen.findByLabelText(/opening balance for visa/i)
    await userEvent.clear(input)
    await userEvent.type(input, '-2100')
    await userEvent.click(screen.getByRole('button', { name: /save visa/i }))
    expect(updateOpeningBalance).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ openingBalance: -2100 }),
    )
    expect(
      screen.queryByText(/opening balance for an asset account can't be negative/i),
    ).not.toBeInTheDocument()
  })

  it('allows zero opening balance on an asset account', async () => {
    vi.mocked(updateOpeningBalance).mockClear()
    render(
      <MemoryRouter>
        <NetWorthPage />
      </MemoryRouter>,
    )
    await userEvent.click(screen.getByRole('button', { name: /opening balances/i }))
    const input = await screen.findByLabelText(/opening balance for chq/i)
    await userEvent.clear(input)
    await userEvent.type(input, '0')
    await userEvent.click(screen.getByRole('button', { name: /save chq/i }))
    expect(updateOpeningBalance).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ openingBalance: 0 }),
    )
  })
})
