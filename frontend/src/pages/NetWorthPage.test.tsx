import React from 'react'
import { afterEach, describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { NetWorthPage } from './NetWorthPage'
import {
  updateOpeningBalance,
  useBalanceIntegrity,
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

const integrityState = (data: {
  statementsChecked: number
  statementMismatches: Array<Record<string, unknown>>
  undatedOpeningBalances: Array<Record<string, unknown>>
}) => ({ data, loading: false, error: null, refresh: () => {} })

function renderWithIntegrity(data: Parameters<typeof integrityState>[0]) {
  vi.mocked(useBalanceIntegrity).mockReturnValue(integrityState(data) as never)
  render(
    <MemoryRouter>
      <NetWorthPage />
    </MemoryRouter>,
  )
}

const cleanIntegrity = () => ({
  data: { statementsChecked: 0, statementMismatches: [], undatedOpeningBalances: [] },
  loading: false,
  error: null,
  refresh: () => {},
})

vi.mock('@/hooks/useNetWorth', () => ({
  useBalanceIntegrity: vi.fn(() => cleanIntegrity()),
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

  it('shows the "No accounts yet" EmptyState with an Add an account CTA when there is no data (#799)', () => {
    vi.mocked(useNetWorthCurrent).mockReturnValue({
      data: null,
      loading: false,
      error: null,
      refresh: () => {},
    })
    try {
      render(
        <MemoryRouter>
          <NetWorthPage />
        </MemoryRouter>,
      )
      expect(screen.getByText('No accounts yet')).toBeInTheDocument()
      const cta = screen.getByRole('link', { name: /add an account/i })
      expect(cta).toHaveAttribute('href', '/settings/accounts')
    } finally {
      vi.mocked(useNetWorthCurrent).mockImplementation(() => loadedCurrent())
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

  it('shows no balance warning when every statement reconciles', () => {
    render(
      <MemoryRouter>
        <NetWorthPage />
      </MemoryRouter>,
    )
    expect(screen.queryByText(/disagree with the bank/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/no opening-balance date/i)).not.toBeInTheDocument()
  })

  describe('balance integrity', () => {
    afterEach(() => {
      vi.mocked(useBalanceIntegrity).mockImplementation(() => cleanIntegrity())
    })

    it('lists statement balance mismatches with computed, statement and delta, and badges the row', () => {
      renderWithIntegrity({
        statementsChecked: 3,
        statementMismatches: [
          {
            accountId: 7,
            accountName: 'Visa',
            accountType: 'credit_card',
            statementId: 11,
            statementDate: '2026-09-03',
            currency: 'CAD',
            computedBalance: 36354.86,
            statementBalance: 22700,
            delta: 13654.86,
          },
        ],
        undatedOpeningBalances: [],
      })
      const alert = screen.getByRole('alert', { name: /statement balances/i })
      expect(alert).toHaveTextContent(/1 statement balance disagrees with the bank/i)
      // Account, statement date, computed, statement, difference.
      for (const cell of ['Visa', '2026-09-03', /36,354\.86/, /22,700\.00/, /13,654\.86/]) {
        expect(within(alert).getByText(cell)).toBeInTheDocument()
      }
      expect(screen.getByText(/Statement mismatch/)).toBeInTheDocument()
    })

    it('warns about an opening balance with no date and badges the row', () => {
      renderWithIntegrity({
        statementsChecked: 0,
        statementMismatches: [],
        undatedOpeningBalances: [
          { accountId: 7, accountName: 'Visa', openingBalance: -13654.86, currency: 'CAD' },
        ],
      })
      const alert = screen.getByRole('alert', { name: /opening balances/i })
      expect(alert).toHaveTextContent(/1 account has an opening balance with no opening-balance date/i)
      expect(within(alert).getByText(/Visa/)).toBeInTheDocument()
      expect(within(alert).getByText(/13,654\.86/)).toBeInTheDocument()
      expect(screen.getByText(/Opening balance undated/)).toBeInTheDocument()
    })
  })
})
