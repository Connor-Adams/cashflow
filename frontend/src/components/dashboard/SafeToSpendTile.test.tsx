import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { SafeToSpendTile } from './SafeToSpendTile'

function mockSafe(value: number, isNegative = false) {
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
})
