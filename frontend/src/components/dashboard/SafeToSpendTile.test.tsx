import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
// SafeToSpendTile is loaded via dynamic import in each test below so vi.mock
// calls can re-resolve module state between scenarios. Don't import it here.

type SurplusOverride = {
  amount: number
  buffer?: number
  topGoal?: { id: number; name: string; currency: string } | null
  payoffVsInvest?: {
    interestSaved: number
    investGain: number
    assumedAnnualReturnRate: number
    horizonYears: number
    recommendation: 'payoff' | 'invest' | 'tie'
  } | null
}

function mockSafe(value: number, isNegative = false, surplus?: SurplusOverride) {
  return {
    data: {
      currency: 'CAD',
      asOfDate: '2026-06-01',
      windowDays: 14,
      windowEndDate: '2026-06-15',
      value,
      isNegative,
      breakdown: {
        currentCash: 3000,
        upcomingRequiredExpenses: 800,
        requiredSavingsContributions: 200,
        expectedCreditCardPayments: 300,
        minimumBuffer: 100,
      },
      settings: {
        minimumCashBuffer: '100.0000',
        safeToSpendWindowDays: 14,
        includeCreditCardBalance: true,
        includeGoalContributions: true,
      },
      // Default to a no-surplus block so the legacy tests stay regression-safe.
      surplus: {
        amount: surplus?.amount ?? 0,
        buffer: surplus?.buffer ?? 100,
        topGoal: surplus?.topGoal ?? null,
        payoffVsInvest: surplus?.payoffVsInvest ?? null,
      },
    },
    loading: false,
    error: null,
    refresh: () => {},
  }
}

describe('SafeToSpendTile', () => {
  it('renders the headline number', () => {
    vi.doMock('@/hooks/useSafeToSpend', () => ({
      useSafeToSpend: () => mockSafe(1600),
    }))
    return import('./SafeToSpendTile').then(({ SafeToSpendTile: T }) => {
      render(
        <MemoryRouter>
          <T />
        </MemoryRouter>,
      )
      expect(screen.getByText(/1,600/)).toBeInTheDocument()
      // "Safe to spend" appears in both the tile label and the breakdown
      // footer when expanded — assert at least one (it's collapsed here).
      expect(screen.getAllByText(/Safe to spend/i).length).toBeGreaterThan(0)
      // Settings link present.
      expect(screen.getByRole('link', { name: /settings/i })).toHaveAttribute(
        'href',
        '/settings',
      )
    })
  })

  it('breakdown toggles open via the show-breakdown button', () => {
    vi.resetModules()
    vi.doMock('@/hooks/useSafeToSpend', () => ({
      useSafeToSpend: () => mockSafe(1600),
    }))
    return import('./SafeToSpendTile').then(({ SafeToSpendTile: T }) => {
      render(
        <MemoryRouter>
          <T />
        </MemoryRouter>,
      )
      // Breakdown rows hidden initially.
      expect(screen.queryByText('Current cash')).not.toBeInTheDocument()
      const button = screen.getByRole('button', { name: /show breakdown/i })
      fireEvent.click(button)
      expect(screen.getByText('Current cash')).toBeInTheDocument()
      expect(screen.getByText(/Upcoming required expenses/i)).toBeInTheDocument()
      expect(screen.getByText(/Required savings contributions/i)).toBeInTheDocument()
      expect(screen.getByText(/Expected credit-card payments/i)).toBeInTheDocument()
      expect(screen.getByText(/Minimum cash buffer/i)).toBeInTheDocument()
    })
  })

  it('shows the negative warning message when value < 0', () => {
    vi.resetModules()
    vi.doMock('@/hooks/useSafeToSpend', () => ({
      useSafeToSpend: () => mockSafe(-500, true),
    }))
    return import('./SafeToSpendTile').then(({ SafeToSpendTile: T }) => {
      render(
        <MemoryRouter>
          <T />
        </MemoryRouter>,
      )
      expect(
        screen.getByText(/committed past your cash on hand/i),
      ).toBeInTheDocument()
    })
  })

  it('renders a loading skeleton when no data yet', () => {
    vi.resetModules()
    vi.doMock('@/hooks/useSafeToSpend', () => ({
      useSafeToSpend: () => ({
        data: null,
        loading: true,
        error: null,
        refresh: () => {},
      }),
    }))
    return import('./SafeToSpendTile').then(({ SafeToSpendTile: T }) => {
      render(
        <MemoryRouter>
          <T />
        </MemoryRouter>,
      )
      expect(screen.getByText(/Loading safe-to-spend/i)).toBeInTheDocument()
    })
  })

  // --- #654 surplus decision hub ----------------------------------------

  it('renders the surplus headline and goal CTA when surplus > 0', () => {
    vi.resetModules()
    vi.doMock('@/hooks/useSafeToSpend', () => ({
      useSafeToSpend: () =>
        mockSafe(1200, false, {
          amount: 1200,
          buffer: 100,
          topGoal: { id: 7, name: 'House fund', currency: 'CAD' },
          payoffVsInvest: null,
        }),
    }))
    return import('./SafeToSpendTile').then(({ SafeToSpendTile: T }) => {
      render(
        <MemoryRouter>
          <T />
        </MemoryRouter>,
      )
      expect(screen.getByText(/surplus/i)).toBeInTheDocument()
      const cta = screen.getByRole('link', { name: /Put it toward House fund/i })
      expect(cta).toHaveAttribute('href', '/goals')
      expect(screen.getByRole('button', { name: /Keep it as headroom/i })).toBeInTheDocument()
    })
  })

  it('hides the actions row when surplus is 0 (regression-safe)', () => {
    vi.resetModules()
    vi.doMock('@/hooks/useSafeToSpend', () => ({
      useSafeToSpend: () => mockSafe(1600), // default surplus.amount === 0
    }))
    return import('./SafeToSpendTile').then(({ SafeToSpendTile: T }) => {
      render(
        <MemoryRouter>
          <T />
        </MemoryRouter>,
      )
      expect(screen.queryByText(/surplus/i)).not.toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: /Keep it as headroom/i }),
      ).not.toBeInTheDocument()
    })
  })

  it('omits the goal CTA when there is no top goal', () => {
    vi.resetModules()
    vi.doMock('@/hooks/useSafeToSpend', () => ({
      useSafeToSpend: () =>
        mockSafe(900, false, { amount: 900, topGoal: null, payoffVsInvest: null }),
    }))
    return import('./SafeToSpendTile').then(({ SafeToSpendTile: T }) => {
      render(
        <MemoryRouter>
          <T />
        </MemoryRouter>,
      )
      expect(screen.getByText(/surplus/i)).toBeInTheDocument()
      expect(
        screen.queryByRole('link', { name: /Put it toward/i }),
      ).not.toBeInTheDocument()
    })
  })

  it('omits the payoff panel when there is no debt', () => {
    vi.resetModules()
    vi.doMock('@/hooks/useSafeToSpend', () => ({
      useSafeToSpend: () =>
        mockSafe(900, false, {
          amount: 900,
          topGoal: { id: 1, name: 'Trip', currency: 'CAD' },
          payoffVsInvest: null,
        }),
    }))
    return import('./SafeToSpendTile').then(({ SafeToSpendTile: T }) => {
      render(
        <MemoryRouter>
          <T />
        </MemoryRouter>,
      )
      expect(screen.queryByText(/Paying down debt|Invested at/i)).not.toBeInTheDocument()
    })
  })

  it('shows the invest-wins sentence when recommendation is invest', () => {
    vi.resetModules()
    vi.doMock('@/hooks/useSafeToSpend', () => ({
      useSafeToSpend: () =>
        mockSafe(2000, false, {
          amount: 2000,
          payoffVsInvest: {
            interestSaved: 300,
            investGain: 900,
            assumedAnnualReturnRate: 0.05,
            horizonYears: 10,
            recommendation: 'invest',
          },
        }),
    }))
    return import('./SafeToSpendTile').then(({ SafeToSpendTile: T }) => {
      render(
        <MemoryRouter>
          <T />
        </MemoryRouter>,
      )
      expect(screen.getByText(/Invested at 5%, this surplus could grow/i)).toBeInTheDocument()
    })
  })

  it('shows the payoff-wins sentence when recommendation is payoff', () => {
    vi.resetModules()
    vi.doMock('@/hooks/useSafeToSpend', () => ({
      useSafeToSpend: () =>
        mockSafe(2000, false, {
          amount: 2000,
          payoffVsInvest: {
            interestSaved: 1200,
            investGain: 400,
            assumedAnnualReturnRate: 0.05,
            horizonYears: 10,
            recommendation: 'payoff',
          },
        }),
    }))
    return import('./SafeToSpendTile').then(({ SafeToSpendTile: T }) => {
      render(
        <MemoryRouter>
          <T />
        </MemoryRouter>,
      )
      expect(screen.getByText(/Paying down debt saves/i)).toBeInTheDocument()
    })
  })

  it('keeping as headroom dismisses the actions for the session', () => {
    vi.resetModules()
    vi.doMock('@/hooks/useSafeToSpend', () => ({
      useSafeToSpend: () =>
        mockSafe(1200, false, {
          amount: 1200,
          topGoal: { id: 7, name: 'House fund', currency: 'CAD' },
          payoffVsInvest: null,
        }),
    }))
    return import('./SafeToSpendTile').then(({ SafeToSpendTile: T }) => {
      render(
        <MemoryRouter>
          <T />
        </MemoryRouter>,
      )
      expect(screen.getByText(/surplus/i)).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: /Keep it as headroom/i }))
      expect(screen.queryByText(/surplus/i)).not.toBeInTheDocument()
    })
  })

  it('shows no surplus actions when safe-to-spend is negative', () => {
    vi.resetModules()
    vi.doMock('@/hooks/useSafeToSpend', () => ({
      // A negative value with a (defensively zero) surplus block.
      useSafeToSpend: () => mockSafe(-500, true, { amount: 0 }),
    }))
    return import('./SafeToSpendTile').then(({ SafeToSpendTile: T }) => {
      render(
        <MemoryRouter>
          <T />
        </MemoryRouter>,
      )
      expect(screen.getByText(/committed past your cash on hand/i)).toBeInTheDocument()
      expect(screen.queryByText(/surplus/i)).not.toBeInTheDocument()
    })
  })
})
