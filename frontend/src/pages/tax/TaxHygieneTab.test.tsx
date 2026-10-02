import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ToastProvider } from '@/components/ui/toast'

void React

const patchTransactionTax = vi.fn()
const refresh = vi.fn()

vi.mock('../../hooks/useTaxHygiene', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  patchTransactionTax: (...a: unknown[]) => patchTransactionTax(...a),
  useTaxSummary: () => ({ data: { data: [] }, loading: false, error: null, refresh }),
  useMissingReceipts: () => ({ data: { data: [], count: 0 }, loading: false, error: null, refresh }),
  useReviewQueue: () => ({
    data: {
      count: 1,
      data: [
        {
          id: 9,
          date: '2025-03-01',
          merchant: 'Staples',
          amount: '42.00',
          currency: 'CAD',
          finalCategory: 'Office',
          finalBusiness: true,
          accountName: null,
          taxTagId: null,
          deductiblePercent: '1',
        },
      ],
    },
    loading: false,
    error: null,
    refresh,
  }),
  useTaxTags: () => ({ tags: [{ id: 3, name: 'Office' }] }),
}))

import { TaxHygieneTab } from './TaxHygieneTab'

function renderTab() {
  return render(
    <ToastProvider>
      <TaxHygieneTab year={2025} />
    </ToastProvider>,
  )
}

describe('TaxHygieneTab review queue saves', () => {
  beforeEach(() => {
    patchTransactionTax.mockReset()
    refresh.mockReset()
  })

  it('tells the user when Mark reviewed fails', async () => {
    patchTransactionTax.mockRejectedValue(new Error('server said no'))
    renderTab()
    fireEvent.click(screen.getByRole('button', { name: 'Mark reviewed' }))
    expect(await screen.findByText('Failed to mark reviewed')).toBeInTheDocument()
    expect(screen.getByText('server said no')).toBeInTheDocument()
    expect(refresh).not.toHaveBeenCalled()
  })

  it('tells the user when a tag change fails', async () => {
    patchTransactionTax.mockRejectedValue(new Error('server said no'))
    renderTab()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '3' } })
    expect(await screen.findByText('Failed to set tax tag')).toBeInTheDocument()
  })
})
