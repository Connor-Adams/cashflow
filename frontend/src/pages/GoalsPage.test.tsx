import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { ToastProvider } from '@/components/ui/toast'
import { GoalsPage } from './GoalsPage'
import { getJson, postJson } from '../lib/api'

// GoalsPage loads goals + accounts through getJson; postJson/deleteReq are
// stubbed. Default impl resolves empty so the page renders its empty state.
vi.mock('../lib/api', () => ({
  getJson: vi.fn((url: string) => {
    if (url.includes('/api/accounts')) return Promise.resolve([])
    if (url.includes('/api/goals')) return Promise.resolve({ data: [] })
    return Promise.resolve({})
  }),
  postJson: vi.fn(() => Promise.resolve({})),
  deleteReq: vi.fn(() => Promise.resolve(undefined)),
}))

function renderPage() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <GoalsPage />
      </ToastProvider>
    </MemoryRouter>,
  )
}

describe('GoalsPage', () => {
  it('renders the page heading', async () => {
    renderPage()
    expect(
      await screen.findByRole('heading', { name: /^goals$/i }),
    ).toBeInTheDocument()
  })

  it('renders a populated goal name', async () => {
    vi.mocked(getJson).mockImplementation((url: string) => {
      if (url.includes('/api/accounts')) return Promise.resolve([])
      if (url.includes('/projection')) return Promise.resolve({})
      if (url.includes('/api/goals'))
        return Promise.resolve({
          data: [
            {
              id: 1,
              name: 'Emergency fund',
              targetAmount: '5000',
              currentAmount: '1000',
              currency: 'CAD',
              targetDate: null,
              monthlyContribution: null,
              linkedAccountId: null,
              priority: 0,
              status: 'active',
              notes: null,
            },
          ],
        })
      return Promise.resolve({})
    })
    renderPage()
    expect(await screen.findByText('Emergency fund')).toBeInTheDocument()
  })

  it('blocks submit and shows an inline error for a negative target amount', async () => {
    // AC #6: negative amount → inline "Amount can't be negative." + no POST.
    vi.mocked(postJson).mockClear()
    const user = userEvent.setup()
    renderPage()
    const nameInput = await screen.findByPlaceholderText(
      /emergency fund, vacation/i,
    )
    await user.type(nameInput, 'Vacation')
    // A native number input still accepts a typed negative in real browsers;
    // jsdom's userEvent strips the leading '-', so set the raw value directly.
    const targetInput = screen.getByLabelText(/target amount/i)
    fireEvent.change(targetInput, { target: { value: '-100' } })
    fireEvent.submit(targetInput.closest('form')!)

    expect(await screen.findByText("Amount can't be negative.")).toBeInTheDocument()
    expect(vi.mocked(postJson)).not.toHaveBeenCalled()
  })

  // ---- #653 forecast-grounded badges ------------------------------------

  type ForecastBlock = {
    currency: string
    monthlyFreeCash: string
    status: string
    requiredMonthlyContribution: string | null
    projectedCompletionDate: string | null
    currencyMismatch: boolean
  }

  function mockGoalWithForecast(forecast: ForecastBlock | null) {
    vi.mocked(getJson).mockImplementation((url: string) => {
      if (url.includes('/api/accounts')) return Promise.resolve([])
      if (url.includes('/projection')) {
        if (forecast === null) return Promise.reject(new Error('boom'))
        return Promise.resolve({
          goalId: 1,
          today: '2026-06-01',
          remainingAmount: '1200.0000',
          progressPercent: 0,
          monthsRemaining: 12,
          requiredMonthlyContribution: '100.0000',
          projectedCompletionDate: null,
          status: 'unfunded',
          forecast,
        })
      }
      if (url.includes('/api/goals'))
        return Promise.resolve({
          data: [
            {
              id: 1,
              name: 'Emergency fund',
              targetAmount: '1200',
              currentAmount: '0',
              currency: 'CAD',
              targetDate: '2027-06-01',
              monthlyContribution: null,
              linkedAccountId: null,
              priority: 0,
              status: 'active',
              notes: null,
            },
          ],
        })
      return Promise.resolve({})
    })
  }

  it('renders the On track forecast badge (AC2, AC10)', async () => {
    mockGoalWithForecast({
      currency: 'CAD',
      monthlyFreeCash: '500.0000',
      status: 'on_track',
      requiredMonthlyContribution: '100.0000',
      projectedCompletionDate: '2027-01-01',
      currencyMismatch: false,
    })
    renderPage()
    expect(await screen.findByText('On track')).toBeInTheDocument()
    // "Need $X/mo to stay on track" line (AC12).
    expect(await screen.findByText(/to stay on track/i)).toBeInTheDocument()
  })

  it('renders the At risk forecast badge (AC3)', async () => {
    mockGoalWithForecast({
      currency: 'CAD',
      monthlyFreeCash: '50.0000',
      status: 'at_risk',
      requiredMonthlyContribution: '100.0000',
      projectedCompletionDate: '2028-01-01',
      currencyMismatch: false,
    })
    renderPage()
    expect(await screen.findByText('At risk')).toBeInTheDocument()
  })

  it('renders the Off track forecast badge (AC4)', async () => {
    mockGoalWithForecast({
      currency: 'CAD',
      monthlyFreeCash: '0.0000',
      status: 'off_track',
      requiredMonthlyContribution: '100.0000',
      projectedCompletionDate: null,
      currencyMismatch: false,
    })
    renderPage()
    expect(await screen.findByText('Off track')).toBeInTheDocument()
  })

  it('renders No deadline when the goal has no target date (AC6)', async () => {
    mockGoalWithForecast({
      currency: 'CAD',
      monthlyFreeCash: '200.0000',
      status: 'no_deadline',
      requiredMonthlyContribution: null,
      projectedCompletionDate: '2026-12-01',
      currencyMismatch: false,
    })
    renderPage()
    expect(await screen.findByText('No deadline')).toBeInTheDocument()
  })

  it("renders Can't validate + mismatch copy on currency mismatch (AC7)", async () => {
    mockGoalWithForecast({
      currency: 'USD',
      monthlyFreeCash: '999.0000',
      status: 'cant_validate',
      requiredMonthlyContribution: null,
      projectedCompletionDate: null,
      currencyMismatch: true,
    })
    renderPage()
    expect(await screen.findByText("Can't validate")).toBeInTheDocument()
    expect(
      await screen.findByText(/differs from forecast/i),
    ).toBeInTheDocument()
  })

  it('shows only the status badge when the projection fetch fails (AC11)', async () => {
    mockGoalWithForecast(null) // projection request rejects
    renderPage()
    // Goal still renders.
    expect(await screen.findByText('Emergency fund')).toBeInTheDocument()
    // No forecast badge for any status.
    for (const label of [
      'On track',
      'At risk',
      'Off track',
      'No deadline',
      "Can't validate",
    ]) {
      expect(screen.queryByText(label)).not.toBeInTheDocument()
    }
  })

  it('renders skeletons while loading', () => {
    // Pin loading=true by making getJson never resolve, then restore the
    // resolving default so the heading test keeps rendering.
    const original = vi.mocked(getJson).getMockImplementation()
    vi.mocked(getJson).mockImplementation(() => new Promise(() => {}))
    try {
      const { container } = renderPage()
      expect(
        container.querySelectorAll('[data-slot="skeleton"]').length,
      ).toBeGreaterThan(0)
    } finally {
      vi.mocked(getJson).mockImplementation(original!)
    }
  })
})
