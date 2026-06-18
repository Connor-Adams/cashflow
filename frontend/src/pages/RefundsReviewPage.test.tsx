import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ToastProvider } from '@/components/ui/toast'
import { RefundsReviewPage } from './RefundsReviewPage'
import { getJson } from '../lib/api'
import type { RefundSuggestionRow } from '../types/api'

vi.mock('../lib/api', () => ({
  getJson: vi.fn(),
  postJson: vi.fn(() => Promise.resolve({})),
  deleteReq: vi.fn(() => Promise.resolve(undefined)),
}))

const mockGetJson = vi.mocked(getJson)

const row: RefundSuggestionRow = {
  refundId: 101,
  refundDate: '2026-05-01',
  refundMerchantClean: 'Patagonia',
  refundAmount: 129.5,
  refundCurrency: 'CAD',
  autoSource: 'canonical-brand',
  autoConfidence: 'high',
  reviewFlag: true,
  linkedOriginal: {
    id: 55,
    date: '2026-04-10',
    merchantClean: 'Patagonia',
    amount: -129.5,
    currency: 'CAD',
    finalCategory: 'Clothing',
  },
  suggestions: [],
}

function renderPage() {
  return render(
    <ToastProvider>
      <RefundsReviewPage />
    </ToastProvider>,
  )
}

describe('RefundsReviewPage', () => {
  it('renders the page header title', async () => {
    mockGetJson.mockResolvedValueOnce({ data: [row] })
    renderPage()
    expect(
      await screen.findByRole('heading', { name: /^refunds review$/i, level: 1 }),
    ).toBeInTheDocument()
  })

  it('renders a fetched refund row with merchant and amount', async () => {
    mockGetJson.mockResolvedValueOnce({ data: [row] })
    renderPage()
    // The merchant + amount share one <p>; match the leaf node to tolerate
    // the currency-locale prefix (CA$) and whitespace normalization.
    expect(
      await screen.findByText((_content, el) => {
        if (el?.tagName !== 'P') return false
        const text = (el.textContent ?? '').trim()
        // The header <p> leads with the merchant; the linked-original <p>
        // leads with "#55", so anchoring on the start disambiguates.
        return text.startsWith('Patagonia') && /129\.50/.test(text)
      }),
    ).toBeInTheDocument()
  })

  it('renders the empty state when there are no refunds', async () => {
    mockGetJson.mockResolvedValueOnce({ data: [] })
    renderPage()
    expect(
      await screen.findByText(/No refunds need review/i),
    ).toBeInTheDocument()
  })
})
