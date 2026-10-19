import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ToastProvider } from '@/components/ui/toast'
import { DebtPage } from './DebtPage'
import { getJson } from '../lib/api'
import type { DebtOverview } from '../types/api'

// Mock the data layer at the api module level (same pattern as SavingsRatePage.test.tsx).
// useDebt calls getJson('/api/debt') internally; intercepting here is sufficient
// and avoids coupling this test to the hook's internal structure.
vi.mock('../lib/api', () => ({
  getJson: vi.fn(),
  postJson: vi.fn(() => Promise.resolve({})),
  putJson: vi.fn(() => Promise.resolve({})),
}))

const getJsonMock = vi.mocked(getJson)

const populatedOverview: DebtOverview = {
  currency: 'CAD',
  totalOwed: 12000,
  totalMinimumPayment: 350,
  unconvertedCurrencies: [],
  extraMonthlyPayment: 200,
  liabilities: [
    {
      accountId: 1,
      name: 'Visa Platinum',
      accountType: 'credit_card',
      currency: 'CAD',
      balance: 12000,
      balanceSource: 'live',
      interestRate: 19.99,
      minimumPayment: 350,
      statementBalance: null,
      dueDay: 15,
      balanceCad: 12000,
      minimumPaymentCad: 350,
    },
  ],
  comparison: {
    avalanche: {
      strategy: 'avalanche',
      order: [1],
      months: [],
      payoffMonthByDebt: { 1: 24 },
      totalMonths: 24,
      totalInterest: 1800,
      totalPaid: 13800,
      scheduledPayments: [],
      stalled: false,
    },
    snowball: {
      strategy: 'snowball',
      order: [1],
      months: [],
      payoffMonthByDebt: { 1: 26 },
      totalMonths: 26,
      totalInterest: 2100,
      totalPaid: 14100,
      scheduledPayments: [],
      stalled: false,
    },
    interestSaved: 300,
  },
}

const emptyOverview: DebtOverview = {
  currency: 'CAD',
  totalOwed: 0,
  totalMinimumPayment: 0,
  unconvertedCurrencies: [],
  extraMonthlyPayment: 0,
  liabilities: [],
  comparison: null,
}

function renderPage() {
  return render(
    <ToastProvider>
      <DebtPage />
    </ToastProvider>,
  )
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('DebtPage', () => {
  it('renders the page heading', async () => {
    getJsonMock.mockResolvedValue(populatedOverview)
    renderPage()
    expect(
      await screen.findByRole('heading', { name: /debt payoff planner/i, level: 1 }),
    ).toBeInTheDocument()
  })

  it('renders the summary tile labels', async () => {
    getJsonMock.mockResolvedValue(populatedOverview)
    renderPage()
    expect(await screen.findByText('Total owed')).toBeInTheDocument()
    expect(screen.getByText('Monthly budget')).toBeInTheDocument()
  })

  it('renders the liabilities table headers', async () => {
    getJsonMock.mockResolvedValue(populatedOverview)
    renderPage()
    expect(
      await screen.findByRole('columnheader', { name: /^account$/i }),
    ).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: /balance owed/i })).toBeInTheDocument()
  })

  it('labels each balance with the source it came from', async () => {
    getJsonMock.mockResolvedValue({
      ...populatedOverview,
      liabilities: [
        populatedOverview.liabilities[0],
        {
          ...populatedOverview.liabilities[0],
          accountId: 2,
          name: 'Amex',
          balanceSource: 'statement',
          statementBalance: 900,
          balance: 900,
        },
      ],
    })
    renderPage()
    expect(await screen.findByText('Live balance')).toBeInTheDocument()
    expect(screen.getByText('Statement balance')).toBeInTheDocument()
  })

  it('renders the empty state when there are no liabilities', async () => {
    getJsonMock.mockResolvedValue(emptyOverview)
    renderPage()
    expect(await screen.findByText('No debts found')).toBeInTheDocument()
  })
})
