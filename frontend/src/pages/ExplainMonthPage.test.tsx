import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ToastProvider } from '@/components/ui/toast'
import { ExplainMonthPage } from './ExplainMonthPage'
import { getJson } from '../lib/api'

// Mock the data layer at the api module level (same pattern as LifestyleInflationPage.test.tsx).
// The page calls getJson directly; intercepting here avoids coupling the test to
// internal call sites and survives the upcoming UI-sweep migration.
vi.mock('../lib/api', () => ({
  getJson: vi.fn(() =>
    Promise.resolve({
      month: '2026-05',
      previousMonth: '2026-04',
      monthOverMonth: [
        {
          currency: 'CAD',
          currentSpend: 4200,
          previousSpend: 3800,
          spendDelta: 400,
          currentIncome: 6000,
          previousIncome: 5800,
          incomeDelta: 200,
          netCurrent: 1800,
          netPrevious: 2000,
          netDelta: -200,
          byCategory: [
            { category: 'Dining', current: 700, previous: 500, delta: 200, deltaPct: 40 },
          ],
        },
      ],
      findings: [
        {
          id: 'f1',
          kind: 'spend_change',
          title: 'Dining up $200 vs last month',
          summary: 'Dining spend rose from $500 to $700 this month.',
          currency: 'CAD',
          monthlyImpact: 200,
          severity: 'medium',
          supportingTransactionIds: [101, 102],
          transactionFilter: { category: 'Dining', dateFrom: '2026-05-01', dateTo: '2026-05-31' },
          meta: {},
        },
        {
          id: 'f2',
          kind: 'missing_receipt',
          title: '3 transactions missing receipts',
          summary: 'These transactions are flagged for receipt attachment.',
          currency: 'CAD',
          monthlyImpact: 0,
          severity: 'low',
          supportingTransactionIds: [103],
          transactionFilter: { reviewFlag: true },
          meta: {},
        },
      ],
      aiSummary: null,
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
        <ExplainMonthPage />
      </ToastProvider>
    </MemoryRouter>,
  )
}

describe('ExplainMonthPage', () => {
  it('renders the page heading', async () => {
    renderPage()
    expect(
      await screen.findByRole('heading', { name: /explain this month/i, level: 1 }),
    ).toBeInTheDocument()
  })

  it('renders the month-over-month section with spend stat label', async () => {
    renderPage()
    // MonthOverMonthSection renders a <dl> with "Spend", "Income", "Net" as <dt> labels
    const spendLabels = await screen.findAllByText('Spend')
    expect(spendLabels.length).toBeGreaterThan(0)
  })

  it('renders the spend_change finding group heading', async () => {
    renderPage()
    // FindingGroup renders KIND_LABEL[kind] as the h3 heading for each group
    expect(
      await screen.findByRole('heading', { name: /top spend changes/i }),
    ).toBeInTheDocument()
  })

  it('renders a finding title from the mocked data', async () => {
    renderPage()
    // Finding items render <strong>{item.title}</strong> inside the list
    expect(
      await screen.findByText('Dining up $200 vs last month'),
    ).toBeInTheDocument()
  })

  it('renders the empty state with a View transactions CTA when there are no findings (#799)', async () => {
    vi.mocked(getJson).mockResolvedValueOnce({
      month: '2026-05',
      previousMonth: '2026-04',
      monthOverMonth: [],
      findings: [],
      aiSummary: null,
    })
    renderPage()
    expect(
      await screen.findByText('Nothing notable this month'),
    ).toBeInTheDocument()
    const cta = screen.getByRole('link', { name: /view transactions/i })
    expect(cta).toHaveAttribute('href', '/transactions')
  })
})
