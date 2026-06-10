import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ToastProvider } from '@/components/ui/toast'
import { TransfersPage } from './TransfersPage'
import { formatMoney } from '../lib/formatMoney'

vi.mock('../lib/api', () => ({
  getJson: vi.fn((path: string) => {
    if (path.startsWith('/api/transfers/stats')) {
      return Promise.resolve({ matched: 6, unmatched: 0, byPurpose: {} })
    }
    if (path.startsWith('/api/transfers/unmatched')) {
      return Promise.resolve({ data: [], page: 1, pageSize: 100, total: 0 })
    }
    if (path.startsWith('/api/transfers/money-movement')) {
      return Promise.resolve({
        flows: [
          {
            sourceAccountId: 1,
            sourceAccountName: 'US Chequing',
            destAccountId: 2,
            destAccountName: 'US Visa',
            sourceCurrency: 'USD',
            destCurrency: 'USD',
            purpose: null,
            totalSourceAmount: 1000,
            totalDestAmount: 1000,
            count: 2,
          },
          {
            sourceAccountId: 3,
            sourceAccountName: 'CAD Chequing',
            destAccountId: 4,
            destAccountName: 'CAD Visa',
            sourceCurrency: 'CAD',
            destCurrency: 'CAD',
            purpose: null,
            totalSourceAmount: 2000,
            totalDestAmount: 2000,
            count: 1,
          },
        ],
        unmatchedCount: 0,
      })
    }
    return Promise.reject(new Error(`unexpected getJson ${path}`))
  }),
  postJson: vi.fn(() => Promise.resolve({})),
  patchJson: vi.fn(() => Promise.resolve({})),
}))

function renderPage() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <TransfersPage />
      </ToastProvider>
    </MemoryRouter>,
  )
}

describe('TransfersPage money movement footer', () => {
  it('totals source movement per currency instead of summing across currencies', async () => {
    renderPage()
    const footer = await screen.findByText(/Total source movement:/)
    // One USD flow (1,000) and one CAD flow (2,000) must never collapse into
    // a single 3,000 figure in either currency — that number exists in no
    // currency. Each currency gets its own native total.
    expect(footer.textContent).toContain(formatMoney(2000, 'CAD'))
    expect(footer.textContent).toContain(formatMoney(1000, 'USD'))
    expect(footer.textContent).not.toContain('3,000')
  })
})
