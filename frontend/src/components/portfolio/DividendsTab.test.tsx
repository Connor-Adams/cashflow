import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { DividendsTab } from './DividendsTab'
import { ToastProvider } from '@/components/ui/toast'
import * as api from '@/lib/api'
import type {
  DividendListResponse,
  DividendReconciliationRow,
  DividendUpcomingRow,
} from '../../types/api'

void React

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, getJson: vi.fn(), postJson: vi.fn() }
})

function reconRow(over: Partial<DividendReconciliationRow> = {}): DividendReconciliationRow {
  return {
    reconciliationId: 1,
    securityDividendId: 10,
    accountId: 5,
    accountName: 'Brokerage',
    symbol: 'XYZ',
    securityName: 'XYZ Corp',
    exDividendDate: '2026-03-01',
    paymentDate: '2026-03-15',
    perShareAmount: '1.00',
    shares: '100.0000000000',
    expectedAmount: 100,
    actualAmount: 100,
    currency: 'USD',
    matchedTransactionId: 999,
    matchedAt: '2026-03-16T00:00:00.000Z',
    matchSource: 'auto',
    variancePct: 0,
    varianceFlag: false,
    ...over,
  }
}

function upcomingRow(over: Partial<DividendUpcomingRow> = {}): DividendUpcomingRow {
  return {
    securityDividendId: 20,
    symbol: 'ABC',
    securityName: 'ABC Inc',
    exDividendDate: '2026-06-01',
    paymentDate: '2026-06-15',
    perShareAmount: '0.50',
    currency: 'USD',
    ...over,
  }
}

function mockLists(opts: {
  upcoming?: DividendUpcomingRow[]
  matched?: DividendReconciliationRow[]
  unmatched?: DividendReconciliationRow[]
}) {
  vi.mocked(api.getJson).mockImplementation(async (path: string) => {
    if (path.includes('status=upcoming')) {
      return { status: 'upcoming', windowMonths: 12, data: opts.upcoming ?? [] } as DividendListResponse
    }
    if (path.includes('status=matched')) {
      return { status: 'matched', windowMonths: 12, data: opts.matched ?? [] } as DividendListResponse
    }
    return { status: 'unmatched', windowMonths: 12, data: opts.unmatched ?? [] } as DividendListResponse
  })
}

function renderTab() {
  return render(
    <ToastProvider>
      <DividendsTab />
    </ToastProvider>,
  )
}

describe('DividendsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders all three sections with their content (AC #6)', async () => {
    mockLists({
      upcoming: [upcomingRow({ symbol: 'ABC' })],
      matched: [reconRow({ reconciliationId: 1, symbol: 'XYZ' })],
      unmatched: [reconRow({ reconciliationId: 2, symbol: 'UNM', matchedTransactionId: null })],
    })
    renderTab()

    await waitFor(() => {
      expect(screen.getByText('Needs review')).toBeInTheDocument()
    })
    expect(screen.getByText('Matched (last 12 months)')).toBeInTheDocument()
    expect(screen.getByText('Upcoming dividends')).toBeInTheDocument()

    // Section content.
    expect(screen.getByTestId('dividends-section-unmatched')).toHaveTextContent('UNM')
    expect(screen.getByTestId('dividends-section-matched')).toHaveTextContent('XYZ')
    expect(screen.getByTestId('dividends-section-upcoming')).toHaveTextContent('ABC')
  })

  it('renders a "Check" variance pill on a >5% matched dividend (AC #10)', async () => {
    mockLists({
      matched: [
        reconRow({
          reconciliationId: 3,
          symbol: 'VAR',
          expectedAmount: 100,
          actualAmount: 110,
          variancePct: 10,
          varianceFlag: true,
        }),
      ],
    })
    renderTab()

    await waitFor(() => {
      expect(screen.getByTestId('dividend-variance-pill')).toBeInTheDocument()
    })
    expect(screen.getByTestId('dividend-variance-pill')).toHaveTextContent('Check')
    expect(screen.getByTestId('dividend-variance-pill').getAttribute('title')).toMatch(/Variance 10/)
  })

  it('shows the empty state when there are no dividends at all', async () => {
    mockLists({})
    renderTab()
    await waitFor(() => {
      expect(screen.getByText(/No dividends recorded yet/i)).toBeInTheDocument()
    })
  })

  it('renders a Match… button for each unmatched row', async () => {
    mockLists({
      unmatched: [reconRow({ reconciliationId: 7, symbol: 'NM1', matchedTransactionId: null })],
    })
    renderTab()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Match…/ })).toBeInTheDocument()
    })
  })
})
