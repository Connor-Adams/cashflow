import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ToastProvider } from '@/components/ui/toast'
import { MoneyLeaksPage } from './MoneyLeaksPage'

// Mock the data layer so tests run without a network. Branch on URL:
// /api/money-leaks/dismissed returns the dismissed shape; everything else
// (i.e. /api/money-leaks?...) returns the main list + totals shape.
vi.mock('../lib/api', () => ({
  getJson: vi.fn((url: string) => {
    if (url === '/api/money-leaks/dismissed') {
      return Promise.resolve({ items: [] })
    }
    // /api/money-leaks (with or without a query string)
    return Promise.resolve({
      items: [
        {
          leakType: 'small_subscription',
          identityKey: 'netflix|CAD',
          title: 'Netflix',
          description: 'Small recurring subscription under $15/mo',
          currency: 'CAD',
          monthlyImpact: 12.99,
          annualImpact: 155.88,
          severity: 'low',
          meta: {},
        },
        {
          leakType: 'recurring_fee',
          identityKey: 'bank-fee|CAD',
          title: 'Monthly bank fee',
          description: 'Recurring account maintenance fee',
          currency: 'CAD',
          monthlyImpact: 14.95,
          annualImpact: 179.4,
          severity: 'medium',
          meta: {},
        },
      ],
      totals: {
        byCurrency: [
          {
            currency: 'CAD',
            monthlyImpact: 27.94,
            annualImpact: 335.28,
            count: 2,
          },
        ],
      },
    })
  }),
  postJson: vi.fn(() => Promise.resolve({})),
  deleteReq: vi.fn(() => Promise.resolve(undefined)),
}))

function renderPage() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <MoneyLeaksPage />
      </ToastProvider>
    </MemoryRouter>,
  )
}

describe('MoneyLeaksPage', () => {
  it('renders the page h1 heading', async () => {
    renderPage()
    expect(
      await screen.findByRole('heading', { name: /money leaks/i, level: 1 }),
    ).toBeInTheDocument()
  })

  it('renders the "Leaks detected" stat label', async () => {
    renderPage()
    expect(await screen.findByText('Leaks detected')).toBeInTheDocument()
  })

  it('renders the small subscriptions leak group heading', async () => {
    renderPage()
    // CollapsibleCard renders the title as a heading; TYPE_LABEL['small_subscription']
    expect(await screen.findByText('Small subscriptions')).toBeInTheDocument()
  })

  it('renders a leak item title', async () => {
    renderPage()
    expect(await screen.findByText('Netflix')).toBeInTheDocument()
  })
})
