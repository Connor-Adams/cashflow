import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ToastProvider } from '@/components/ui/toast'
import { SavingsRatePage } from './SavingsRatePage'

// Mock the data layer at the api module level (same pattern as AccountsPage.test.tsx).
// useReportData calls getJson internally, so intercepting here is sufficient
// and avoids coupling this test to the hook's internal structure.
vi.mock('../lib/api', () => ({
  getJson: vi.fn(() =>
    Promise.resolve({
      anchorMonth: '2026-05',
      scope: 'all',
      currency: null,
      windowMonths: ['2025-06', '2025-07', '2025-08', '2025-09', '2025-10', '2025-11',
                     '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05'],
      includeInvestments: true,
      includeDebtPrincipal: true,
      byCurrency: [
        {
          currency: 'CAD',
          totals: {
            income: 10000,
            spending: 6000,
            savings: 1000,
            investments: 500,
            debtPrincipal: 250,
            savingsRatePct: 17.5,
          },
          series: [
            {
              month: '2026-04',
              income: 5000,
              spending: 3000,
              savings: 500,
              investments: 250,
              debtPrincipal: 125,
              savingsRatePct: 17.5,
            },
            {
              month: '2026-05',
              income: 5000,
              spending: 3000,
              savings: 500,
              investments: 250,
              debtPrincipal: 125,
              savingsRatePct: 17.5,
            },
          ],
        },
      ],
    }),
  ),
  postJson: vi.fn(() => Promise.resolve({})),
  patchJson: vi.fn(() => Promise.resolve({})),
  deleteReq: vi.fn(() => Promise.resolve(undefined)),
}))

function renderPage() {
  return render(
    <ToastProvider>
      <SavingsRatePage />
    </ToastProvider>,
  )
}

describe('SavingsRatePage', () => {
  it('renders the page heading', async () => {
    renderPage()
    expect(
      await screen.findByRole('heading', { name: /savings rate/i, level: 1 }),
    ).toBeInTheDocument()
  })

  it('renders a currency summary stat label', async () => {
    renderPage()
    // The CurrencySummaryCard renders Stat tiles with labels: Income, Spending, Savings, etc.
    // "Income" appears in both the stat tile and the monthly table header — either instance suffices.
    const incomeEls = await screen.findAllByText('Income')
    expect(incomeEls.length).toBeGreaterThan(0)
  })

  it('renders the monthly table column headers', async () => {
    renderPage()
    // MonthlySeriesTable renders a <table> with these column headers
    expect(await screen.findByRole('columnheader', { name: /^income$/i })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: /savings rate/i })).toBeInTheDocument()
  })

  it('renders the formula explainer section', async () => {
    renderPage()
    expect(
      await screen.findByRole('region', { name: /how the savings rate is calculated/i }),
    ).toBeInTheDocument()
  })
})
