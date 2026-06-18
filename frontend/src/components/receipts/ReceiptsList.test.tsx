import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { ReceiptsList } from './ReceiptsList'

vi.mock('@/lib/api', () => ({
  getJson: vi.fn(),
}))
import { getJson } from '@/lib/api'

const FULL_ORDER = {
  id: 1,
  vendor: 'costco',
  source: 'costco_till_receipt.pdf',
  orderDate: '2026-02-13',
  subtotal: '555.64',
  tax: '27.00',
  shipping: null,
  total: '582.64',
  currency: 'CAD',
  paymentLast4: '4021',
  linkStatus: 'linked',
  items: [
    { id: 5, title: 'LEGO 10374', quantity: 1, unitPrice: null, totalPrice: '59.99', inferredCategory: 'Toys' },
    { id: 6, title: 'Campo Viejo', quantity: 2, unitPrice: null, totalPrice: '31.98', inferredCategory: 'Alcohol' },
  ],
}

describe('ReceiptsList', () => {
  beforeEach(() => {
    vi.mocked(getJson).mockReset()
  })

  it('fetches with the group param and renders order rows with link status', async () => {
    vi.mocked(getJson).mockResolvedValue([FULL_ORDER])
    render(<ReceiptsList group="gmail" />)
    await waitFor(() => expect(screen.getByText('costco')).toBeInTheDocument())
    expect(getJson).toHaveBeenCalledWith('/api/external-orders?group=gmail')
    expect(screen.getByText(/linked/i)).toBeInTheDocument()
  })

  it('renders skeletons while loading', () => {
    // never-resolving getJson keeps orders === null, so the skeleton list
    // renders. beforeEach mockReset tears this down for the next test.
    vi.mocked(getJson).mockImplementation(() => new Promise(() => {}))
    const { container } = render(<ReceiptsList group="all" />)
    expect(
      container.querySelectorAll('[data-slot="skeleton"]').length,
    ).toBeGreaterThan(0)
  })

  it('shows an empty state when there are no receipts', async () => {
    vi.mocked(getJson).mockResolvedValue([])
    render(<ReceiptsList group="all" />)
    await waitFor(() => expect(screen.getByText(/no receipts/i)).toBeInTheDocument())
  })

  it('renders the financial breakdown for present fields', async () => {
    vi.mocked(getJson).mockResolvedValue([FULL_ORDER])
    render(<ReceiptsList group="other" />)
    // 'Breakdown' / 'Subtotal' are unique to the panel; 'Tax'/'Total' are NOT
    // (they also label the collapsed-row columns), so assert via unique strings.
    await waitFor(() => expect(screen.getByText('Breakdown')).toBeInTheDocument())
    expect(screen.getByText('Subtotal')).toBeInTheDocument()
    expect(screen.getByText('CA$555.64')).toBeInTheDocument()
    expect(screen.getAllByText('CA$582.64').length).toBeGreaterThan(0)
    expect(screen.getByText(/4021/)).toBeInTheDocument()
  })

  it('hides breakdown lines whose values are null', async () => {
    vi.mocked(getJson).mockResolvedValue([
      { ...FULL_ORDER, subtotal: null, tax: null, shipping: null, paymentLast4: null },
    ])
    render(<ReceiptsList group="other" />)
    await waitFor(() => expect(screen.getByText('costco')).toBeInTheDocument())
    // 'Subtotal'/'Shipping' are panel-only labels; 'Tax' also heads a column, so
    // prove tax is hidden via its (now absent) value instead of the word.
    expect(screen.queryByText('Subtotal')).not.toBeInTheDocument()
    expect(screen.queryByText('Shipping')).not.toBeInTheDocument()
    expect(screen.queryByText('CA$27.00')).not.toBeInTheDocument()
    expect(screen.queryByText(/paid with/i)).not.toBeInTheDocument()
  })

  it('renders the category roll-up when items have categories, and omits it otherwise', async () => {
    vi.mocked(getJson).mockResolvedValue([FULL_ORDER])
    const { unmount } = render(<ReceiptsList group="other" />)
    await waitFor(() => expect(screen.getByText(/where it went/i)).toBeInTheDocument())
    expect(screen.getByText('Toys')).toBeInTheDocument()
    expect(screen.getByText('Alcohol')).toBeInTheDocument()
    unmount()

    vi.mocked(getJson).mockResolvedValue([
      {
        ...FULL_ORDER,
        items: [{ id: 9, title: 'mystery', quantity: 1, unitPrice: null, totalPrice: '5.00', inferredCategory: null }],
      },
    ])
    render(<ReceiptsList group="other" />)
    await waitFor(() => expect(screen.getByText('mystery')).toBeInTheDocument())
    expect(screen.queryByText(/where it went/i)).not.toBeInTheDocument()
  })

  it('renders a summary bar with orphan count shown only when there are orphans', async () => {
    vi.mocked(getJson).mockResolvedValue([
      FULL_ORDER,
      { ...FULL_ORDER, id: 2, linkStatus: 'orphan', total: '100.00', tax: null },
    ])
    const { unmount } = render(<ReceiptsList group="all" />)
    await waitFor(() => expect(screen.getByText('receipts')).toBeInTheDocument())
    expect(screen.getByText('orphan')).toBeInTheDocument()
    unmount()

    vi.mocked(getJson).mockResolvedValue([FULL_ORDER])
    render(<ReceiptsList group="all" />)
    await waitFor(() => expect(screen.getByText('receipts')).toBeInTheDocument())
    expect(screen.queryByText('orphan')).not.toBeInTheDocument()
  })
})
