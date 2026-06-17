import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { BudgetProgress } from '@/types/api'

function progressRow(
  overrides: Partial<BudgetProgress> & {
    budgetId: number
    category: string | null
    percentUsed: number
  },
): BudgetProgress {
  return {
    budgetId: overrides.budgetId,
    category: overrides.category,
    currency: overrides.currency ?? 'CAD',
    target: overrides.target ?? 100,
    spent: overrides.spent ?? overrides.percentUsed,
    remaining: overrides.remaining ?? overrides.target ?? 0,
    percentUsed: overrides.percentUsed,
    periodStart: overrides.periodStart ?? '2026-05-01',
    periodEnd: overrides.periodEnd ?? '2026-05-31',
    scope: overrides.scope ?? 'household',
    period: overrides.period ?? 'monthly',
    rolloverEnabled: overrides.rolloverEnabled ?? false,
    periodElapsedPercent: overrides.periodElapsedPercent ?? 50,
    pacingState: overrides.pacingState ?? 'on-pace',
  }
}

/**
 * Route-aware mock for `lib/api.getJson`. CategoryIcon's useCategories hook
 * fires its own /api/categories request at mount; if we return the items
 * payload there it explodes with "categories.find is not a function". So we
 * pattern-match the path and return the right shape per endpoint.
 */
function mockApi(statusItems: BudgetProgress[]) {
  vi.resetModules()
  vi.doMock('@/lib/api', () => ({
    getJson: vi.fn((path: string) => {
      if (path.startsWith('/api/budgets/status')) {
        return Promise.resolve({ items: statusItems })
      }
      return Promise.resolve([])
    }),
  }))
}

describe('BudgetStatusCard', () => {
  it('renders an "On track" pill when percentUsed is under 80', async () => {
    mockApi([progressRow({ budgetId: 1, category: 'Groceries', percentUsed: 42 })])
    const { BudgetStatusCard } = await import('./BudgetStatusCard')
    render(
      <MemoryRouter>
        <BudgetStatusCard />
      </MemoryRouter>,
    )
    const pill = await screen.findByTestId('budget-status-pill-1')
    expect(pill).toHaveTextContent('On track')
    expect(pill.className).toMatch(/success/)
  })

  it('renders an "At risk" pill in the 80–100 band', async () => {
    mockApi([progressRow({ budgetId: 2, category: 'Dining', percentUsed: 92 })])
    const { BudgetStatusCard } = await import('./BudgetStatusCard')
    render(
      <MemoryRouter>
        <BudgetStatusCard />
      </MemoryRouter>,
    )
    const pill = await screen.findByTestId('budget-status-pill-2')
    expect(pill).toHaveTextContent('At risk')
    expect(pill.className).toMatch(/warning/)
  })

  it('renders an "Over" pill past 100', async () => {
    mockApi([progressRow({ budgetId: 3, category: 'Subs', percentUsed: 130 })])
    const { BudgetStatusCard } = await import('./BudgetStatusCard')
    render(
      <MemoryRouter>
        <BudgetStatusCard />
      </MemoryRouter>,
    )
    const pill = await screen.findByTestId('budget-status-pill-3')
    expect(pill).toHaveTextContent('Over')
    expect(pill.className).toMatch(/danger/)
  })

  it('renders the percentage and a fallback "Overall" label', async () => {
    mockApi([progressRow({ budgetId: 4, category: null, percentUsed: 50 })])
    const { BudgetStatusCard } = await import('./BudgetStatusCard')
    render(
      <MemoryRouter>
        <BudgetStatusCard />
      </MemoryRouter>,
    )
    expect(await screen.findByText('50%')).toBeInTheDocument()
    expect(screen.getByText('Overall')).toBeInTheDocument()
  })

  it('renders nothing when there are no budgets', async () => {
    mockApi([])
    const { BudgetStatusCard } = await import('./BudgetStatusCard')
    const { container } = render(
      <MemoryRouter>
        <BudgetStatusCard />
      </MemoryRouter>,
    )
    await waitFor(() => {
      expect(
        screen.queryByTestId('budget-status-list'),
      ).not.toBeInTheDocument()
    })
    expect(container.querySelector('[aria-busy]')).toBeNull()
  })
})
