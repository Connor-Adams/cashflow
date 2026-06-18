import React from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ToastProvider } from '@/components/ui/toast'
import { getJson } from '../lib/api'
import type { CreditCardsOverview } from '../types/api'

vi.mock('../lib/api', () => ({
  getJson: vi.fn(),
  putJson: vi.fn(() => Promise.resolve({})),
  postJson: vi.fn(() => Promise.resolve({})),
}))

const mockedGetJson = vi.mocked(getJson)

const overview: CreditCardsOverview = {
  currency: 'CAD',
  asOfDate: '2026-06-18',
  cards: [
    {
      accountId: 1,
      name: 'Aeroplan Visa Infinite',
      accountType: 'credit_card',
      currency: 'CAD',
      currentBalance: 1842.5,
      statementBalance: 1500,
      minimumPayment: 50,
      dueDay: 22,
      statementDate: '2026-06-01',
      autopayEnabled: true,
      autopayType: 'full',
      autopayAmount: null,
      paymentAccountId: null,
      creditLimit: 10000,
      utilizationPct: 18,
      nextDueDate: '2026-06-22',
      daysUntilDue: 4,
      dueSoon: true,
    },
  ],
}

function renderPage() {
  return render(
    <ToastProvider>
      <CreditCardPlannerPage />
    </ToastProvider>,
  )
}

// Import after the mock is declared so the hook picks up the mocked api module.
import { CreditCardPlannerPage } from './CreditCardPlannerPage'

describe('CreditCardPlannerPage', () => {
  beforeEach(() => {
    mockedGetJson.mockReset()
  })

  it('renders the page header', async () => {
    mockedGetJson.mockResolvedValue(overview)
    renderPage()
    expect(
      await screen.findByRole('heading', { name: /credit card payments/i, level: 1 }),
    ).toBeInTheDocument()
  })

  it('renders a summary tile label', async () => {
    mockedGetJson.mockResolvedValue(overview)
    renderPage()
    expect(await screen.findByText(/total statement owed/i)).toBeInTheDocument()
  })

  it('renders the card table column headers and the fetched card name', async () => {
    mockedGetJson.mockResolvedValue(overview)
    renderPage()
    expect(await screen.findByText('Aeroplan Visa Infinite')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: /^card$/i })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: /autopay/i })).toBeInTheDocument()
  })

  it('renders the empty state when there are no cards', async () => {
    mockedGetJson.mockResolvedValue({ ...overview, cards: [] })
    renderPage()
    expect(await screen.findByText(/no credit cards found/i)).toBeInTheDocument()
  })
})
