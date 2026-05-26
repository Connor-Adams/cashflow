import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { ReceiptCoverageTile } from './ReceiptCoverageTile'

// Mock the data hook. The tile only consumes the headline numbers + a small
// items list; mocking the hook lets us drive the render without needing fetch.
vi.mock('@/hooks/useReceiptCompleteness', () => ({
  useReceiptCompleteness: () => ({
    data: {
      filter: 'all',
      currency: 'CAD',
      totalCount: 12,
      withReceiptCount: 9,
      missingCount: 3,
      totalAmount: 1000,
      withReceiptAmount: 730,
      missingAmount: 270,
      coverageByCount: 0.75,
      coverageByAmount: 0.73,
      byCurrency: [],
    },
    loading: false,
    error: null,
    refresh: () => {},
  }),
  useMissingReceipts: () => ({
    data: {
      items: [
        {
          id: 101,
          date: '2026-05-04',
          currency: 'CAD',
          merchant: 'Costco Wholesale',
          category: 'Groceries',
          amount: -250,
          finalBusiness: false,
        },
      ],
    },
    loading: false,
    error: null,
    refresh: () => {},
  }),
  notifyReceiptsChanged: () => {},
}))

describe('ReceiptCoverageTile', () => {
  it('renders coverage % by count and by amount, plus missing summary and the largest missing row', () => {
    render(
      <MemoryRouter>
        <ReceiptCoverageTile />
      </MemoryRouter>,
    )
    expect(screen.getByText('75%')).toBeInTheDocument()
    expect(screen.getByText('73%')).toBeInTheDocument()
    expect(
      screen.getByText(/Missing 3 receipts worth/i),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Costco Wholesale' })).toHaveAttribute(
      'href',
      '/transactions?ids=101',
    )
    // Filter chips render in default 'All' state.
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByRole('button', { name: 'Business' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    expect(screen.getByRole('button', { name: 'Tax-relevant' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('clicking a filter chip flips aria-pressed', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <ReceiptCoverageTile />
      </MemoryRouter>,
    )
    await user.click(screen.getByRole('button', { name: 'Business' }))
    expect(screen.getByRole('button', { name: 'Business' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })
})
