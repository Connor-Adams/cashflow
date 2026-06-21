import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ToastProvider } from '@/components/ui/toast'
import { ScenariosPage } from './ScenariosPage'
import type { FinancialScenario } from '../types/financialScenario'

// Mutable list the mocked getJson returns — each test sets it before rendering.
let mockScenarios: FinancialScenario[] = []

vi.mock('../lib/api', () => ({
  getJson: vi.fn(() => Promise.resolve({ data: mockScenarios })),
  postJson: vi.fn(() => Promise.resolve({})),
  patchJson: vi.fn(() => Promise.resolve({})),
  deleteReq: vi.fn(() => Promise.resolve(undefined)),
}))

function makeScenario(overrides: Partial<FinancialScenario> = {}): FinancialScenario {
  return {
    id: 1,
    householdId: 1,
    userId: 1,
    name: 'What if I buy a car?',
    assumptionsJson: {
      name: 'What if I buy a car?',
      baselineDays: 30,
      overrides: [
        {
          label: 'Car payment',
          type: 'expense',
          amount: 500,
          startDate: '2026-06-01',
          endDate: null,
          recurrence: 'monthly',
          direction: 'out',
        },
      ],
    },
    resultJson: {
      currency: 'CAD',
      dateFrom: '2026-06-01',
      dateTo: '2026-07-01',
      baseline: {
        closing: 10000,
        lowest: 8000,
        lowestDate: '2026-06-15',
        dailyPoints: [
          { date: '2026-06-01', balance: 9000 },
          { date: '2026-06-15', balance: 8000 },
          { date: '2026-07-01', balance: 10000 },
        ],
      },
      scenario: {
        closing: 9500,
        lowest: 7500,
        lowestDate: '2026-06-15',
        dailyPoints: [
          { date: '2026-06-01', balance: 8800 },
          { date: '2026-06-15', balance: 7500 },
          { date: '2026-07-01', balance: 9500 },
        ],
      },
      deltas: {
        closing: -500,
        lowest: -500,
        lowestDateChanged: false,
      },
    },
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  }
}

function renderPage() {
  return render(
    <ToastProvider>
      <ScenariosPage />
    </ToastProvider>,
  )
}

describe('ScenariosPage', () => {
  it('renders the page heading', async () => {
    mockScenarios = [makeScenario()]
    renderPage()
    expect(
      await screen.findByRole('heading', { name: /scenario planner/i, level: 1 }),
    ).toBeInTheDocument()
  })

  it('renders the scenarios table column headers', async () => {
    mockScenarios = [makeScenario()]
    renderPage()
    expect(await screen.findByRole('columnheader', { name: /^name$/i })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: /closing delta/i })).toBeInTheDocument()
  })

  it('renders a scenario name from the list', async () => {
    mockScenarios = [makeScenario({ name: 'What if income drops 30%?' })]
    renderPage()
    expect(
      await screen.findByRole('button', { name: /what if income drops 30%/i }),
    ).toBeInTheDocument()
  })

  it('renders the empty state when there are no scenarios', async () => {
    mockScenarios = []
    renderPage()
    expect(await screen.findByText(/no scenarios yet/i)).toBeInTheDocument()
  })
})
