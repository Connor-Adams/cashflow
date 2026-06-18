import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ToastProvider } from '@/components/ui/toast'
import { LifestyleInflationPage } from './LifestyleInflationPage'

// Mock the data layer at the api module level (same pattern as SavingsRatePage.test.tsx).
// useReportData calls getJson internally, so intercepting here is sufficient
// and avoids coupling this test to the hook's internal structure.
vi.mock('../lib/api', () => ({
  getJson: vi.fn(() =>
    Promise.resolve({
      anchorMonth: '2026-05',
      scope: 'all',
      currency: null,
      windowMonths: [
        '2025-06', '2025-07', '2025-08', '2025-09', '2025-10', '2025-11',
        '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05',
      ],
      byCurrency: [
        {
          currency: 'CAD',
          series: [
            { month: '2026-04', income: 6000, spend: 4000, savings: 2000 },
            { month: '2026-05', income: 6200, spend: 4400, savings: 1800 },
          ],
          spendGrowth: { firstHalfAvg: 3800, secondHalfAvg: 4200, delta: 400 },
          incomeGrowth: { firstHalfAvg: 5800, secondHalfAvg: 6100, delta: 300 },
          savingsGrowth: { firstHalfAvg: 2000, secondHalfAvg: 1900, delta: -100 },
          spendGrowthPct: 10.5,
          incomeGrowthPct: 5.2,
          savingsGrowthPct: -5.0,
          spendOutpacingIncome: true,
          categoryDrivers: [
            {
              category: 'Dining',
              firstHalfAvg: 500,
              secondHalfAvg: 700,
              delta: 200,
              deltaPct: 40,
            },
          ],
          insight: {
            kind: 'lifestyle_inflation',
            currency: 'CAD',
            severity: 'medium',
            title: 'Spend growing faster than income',
            summary: 'Your spending is growing 5.3 percentage points faster than income.',
            gapPct: 5.3,
            meta: {},
          },
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
    <MemoryRouter>
      <ToastProvider>
        <LifestyleInflationPage />
      </ToastProvider>
    </MemoryRouter>,
  )
}

describe('LifestyleInflationPage', () => {
  it('renders the page heading', async () => {
    renderPage()
    expect(
      await screen.findByRole('heading', { name: /lifestyle inflation/i, level: 1 }),
    ).toBeInTheDocument()
  })

  it('renders a growth-stat label with data', async () => {
    renderPage()
    // GrowthStat tiles render a muted label for each metric; "Avg monthly spend" is the first
    const labels = await screen.findAllByText('Avg monthly spend')
    expect(labels.length).toBeGreaterThan(0)
  })

  it('renders the monthly table column headers', async () => {
    renderPage()
    // MonthlySeriesTable renders <th> column headers: Month, Income, Spend, Savings
    expect(await screen.findByRole('columnheader', { name: /^income$/i })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: /^spend$/i })).toBeInTheDocument()
  })

  it('renders the currency section for the mocked data', async () => {
    renderPage()
    // CurrencyTrendCard renders an aria-label section per currency
    expect(
      await screen.findByRole('region', { name: /lifestyle inflation — cad/i }),
    ).toBeInTheDocument()
  })
})
