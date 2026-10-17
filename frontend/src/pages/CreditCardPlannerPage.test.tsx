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
  totals: { currency: 'CAD', statementOwed: 1500, minimumDue: 50, unconvertedCurrencies: [] },
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
      closed: false,
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

  it('renders the server CAD totals and each card in its own currency', async () => {
    // USD 2,000 card + CAD 10,000 card: the tile must show the server's
    // FX-converted CAD total, not a client-side sum labelled "CA$12,000".
    mockedGetJson.mockResolvedValue({
      ...overview,
      totals: { currency: 'CAD', statementOwed: 12800, minimumDue: 270, unconvertedCurrencies: [] },
      cards: [
        { ...overview.cards[0], accountId: 1, name: 'USD Card', currency: 'USD', currentBalance: 2000, statementBalance: null, minimumPayment: 50 },
        { ...overview.cards[0], accountId: 2, name: 'CAD Card', currency: 'CAD', currentBalance: 10000, statementBalance: null, minimumPayment: 220 },
      ],
    })
    renderPage()
    expect(await screen.findByText('USD Card')).toBeInTheDocument()
    expect(screen.getByText('$12,800.00')).toBeInTheDocument()
    expect(screen.queryByText('$12,000.00')).not.toBeInTheDocument()
    expect(screen.getByText('US$2,000.00')).toBeInTheDocument()
  })

  it('flags currencies left out of the totals for want of an FX rate', async () => {
    mockedGetJson.mockResolvedValue({
      ...overview,
      totals: { ...overview.totals, unconvertedCurrencies: ['EUR'] },
    })
    renderPage()
    expect(await screen.findAllByText(/excludes EUR/i)).toHaveLength(2)
  })

  it('renders the empty state when there are no cards', async () => {
    mockedGetJson.mockResolvedValue({ ...overview, cards: [] })
    renderPage()
    expect(await screen.findByText(/no credit cards found/i)).toBeInTheDocument()
  })
})
