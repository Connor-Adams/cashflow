import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { ReceiptsList } from './ReceiptsList'

vi.mock('@/lib/api', () => ({
  getJson: vi.fn(),
}))
import { getJson } from '@/lib/api'

describe('ReceiptsList', () => {
  beforeEach(() => {
    vi.mocked(getJson).mockReset()
  })

  it('fetches with the group param and renders order rows with link status', async () => {
    vi.mocked(getJson).mockResolvedValue([
      {
        id: 1,
        vendor: 'apple',
        source: 'email_gmail_apple',
        orderDate: '2026-05-20',
        total: '9.99',
        currency: 'CAD',
        paymentLast4: null,
        linkStatus: 'linked',
        items: [{ id: 5, title: 'iCloud+', quantity: 1, unitPrice: null, totalPrice: '9.99', inferredCategory: null }],
      },
    ])
    render(<ReceiptsList group="gmail" />)
    await waitFor(() => expect(screen.getByText('apple')).toBeInTheDocument())
    expect(getJson).toHaveBeenCalledWith('/api/external-orders?group=gmail')
    expect(screen.getByText(/linked/i)).toBeInTheDocument()
  })

  it('shows an empty state when there are no receipts', async () => {
    vi.mocked(getJson).mockResolvedValue([])
    render(<ReceiptsList group="all" />)
    await waitFor(() => expect(screen.getByText(/no receipts/i)).toBeInTheDocument())
  })
})
