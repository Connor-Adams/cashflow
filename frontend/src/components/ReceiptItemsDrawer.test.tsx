import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import ReceiptItemsDrawer from './ReceiptItemsDrawer'
import type { ReceiptWithItems } from '../../../shared/api-types'

function makeFetchOk(body: unknown = {}) {
  return vi.fn(() =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response),
  )
}

const CATEGORY_HINTS = ['Groceries', 'Electronics', 'Home']

const RECEIPT_WITH_ORDER: ReceiptWithItems = {
  id: 1,
  transactionId: 10,
  originalName: 'order_1234.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 1000,
  extractedNote: null,
  createdAt: '2024-01-01T00:00:00Z',
  externalOrderId: 99,
  order: {
    id: 99,
    vendor: 'Amazon',
    subtotal: '18.00',
    tax: '2.34',
    shipping: null,
    total: '20.34',
    currency: 'CAD',
  },
  items: [
    {
      id: 101,
      externalOrderId: 99,
      title: 'Eggs',
      quantity: 1,
      unitPrice: '9.00',
      totalPrice: '9.00',
      inferredCategory: 'Groceries',
      categoryOverride: null,
      businessUsePercent: null,
      businessUseOverride: null,
    },
    {
      id: 102,
      externalOrderId: 99,
      title: 'Soap',
      quantity: 2,
      unitPrice: '4.50',
      totalPrice: '9.00',
      inferredCategory: null,
      categoryOverride: null,
      businessUsePercent: null,
      businessUseOverride: null,
    },
  ],
}

const RECEIPT_NO_ORDER: ReceiptWithItems = {
  id: 2,
  transactionId: 11,
  originalName: 'receipt_xyz.jpg',
  mimeType: 'image/jpeg',
  sizeBytes: 500,
  extractedNote: null,
  createdAt: '2024-01-02T00:00:00Z',
  externalOrderId: null,
  order: null,
  items: [],
}

describe('ReceiptItemsDrawer', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', makeFetchOk())
  })

  it('renders items and totals when receipt has an order', async () => {
    render(
      <ReceiptItemsDrawer
        open={true}
        onClose={vi.fn()}
        receipts={[RECEIPT_WITH_ORDER]}
        categoryHints={CATEGORY_HINTS}
        onExtract={vi.fn()}
      />,
    )

    expect(screen.getByText('Eggs')).toBeInTheDocument()
    expect(screen.getByText('Soap')).toBeInTheDocument()
    expect(screen.getByText('Subtotal')).toBeInTheDocument()
    expect(screen.getByText('Tax')).toBeInTheDocument()
    // 'Total' appears as both a column header and a footer row label — both are correct
    expect(screen.getAllByText('Total').length).toBeGreaterThanOrEqual(1)
  })

  it('shows the AI-expanded displayName with the raw receipt title as secondary text', () => {
    const receipt: ReceiptWithItems = {
      ...RECEIPT_WITH_ORDER,
      order: { ...RECEIPT_WITH_ORDER.order!, vendor: 'costco' },
      items: [
        {
          id: 201,
          externalOrderId: 99,
          title: 'KS ORG PNT BTR',
          displayName: 'Kirkland Signature Organic Peanut Butter',
          quantity: 1,
          unitPrice: '9.99',
          totalPrice: '9.99',
          inferredCategory: null,
          categoryOverride: null,
          businessUsePercent: null,
          businessUseOverride: null,
        },
      ],
    }

    render(
      <ReceiptItemsDrawer
        open={true}
        onClose={vi.fn()}
        receipts={[receipt]}
        categoryHints={CATEGORY_HINTS}
        onExtract={vi.fn()}
      />,
    )

    // Readable name is shown, and the raw receipt text remains visible as secondary.
    expect(screen.getByText('Kirkland Signature Organic Peanut Butter')).toBeInTheDocument()
    expect(screen.getByText('KS ORG PNT BTR')).toBeInTheDocument()
  })

  it('shows Extract items button and fires onExtract when no externalOrderId', async () => {
    const onExtract = vi.fn().mockResolvedValue(undefined)

    render(
      <ReceiptItemsDrawer
        open={true}
        onClose={vi.fn()}
        receipts={[RECEIPT_NO_ORDER]}
        categoryHints={CATEGORY_HINTS}
        onExtract={onExtract}
      />,
    )

    const btn = screen.getByRole('button', { name: /extract items/i })
    fireEvent.click(btn)

    await waitFor(() => expect(onExtract).toHaveBeenCalledWith(RECEIPT_NO_ORDER.id))
  })

  it('PATCHes when Category override select changes and blurs', async () => {
    const fetchMock = makeFetchOk()
    vi.stubGlobal('fetch', fetchMock)

    render(
      <ReceiptItemsDrawer
        open={true}
        onClose={vi.fn()}
        receipts={[RECEIPT_WITH_ORDER]}
        categoryHints={CATEGORY_HINTS}
        onExtract={vi.fn()}
      />,
    )

    // The first item (Eggs, id=101) has inferredCategory 'Groceries', no override
    const selects = screen.getAllByRole('combobox')
    // change to Electronics
    fireEvent.change(selects[0], { target: { value: 'Electronics' } })
    fireEvent.blur(selects[0])

    await waitFor(() => {
      const calls = fetchMock.mock.calls
      const patchCall = calls.find(
        (c) =>
          typeof c[0] === 'string' &&
          c[0].includes('/api/external-order-items/101') &&
          (c[1] as RequestInit)?.method === 'PATCH',
      )
      expect(patchCall).toBeDefined()
      const body = JSON.parse((patchCall![1] as RequestInit).body as string)
      expect(body).toHaveProperty('categoryOverride', 'Electronics')
    })
  })

  it('PATCHes businessUseOverride when business % input changes and blurs', async () => {
    const fetchMock = makeFetchOk()
    vi.stubGlobal('fetch', fetchMock)

    const receiptWithNullBusiness: ReceiptWithItems = {
      ...RECEIPT_WITH_ORDER,
      items: [
        {
          id: 101,
          externalOrderId: 99,
          title: 'Eggs',
          quantity: 1,
          unitPrice: '9.00',
          totalPrice: '9.00',
          inferredCategory: 'Groceries',
          categoryOverride: null,
          businessUsePercent: null,
          businessUseOverride: null,
        },
      ],
    }

    render(
      <ReceiptItemsDrawer
        open={true}
        onClose={vi.fn()}
        receipts={[receiptWithNullBusiness]}
        categoryHints={CATEGORY_HINTS}
        onExtract={vi.fn()}
      />,
    )

    const input = screen.getByRole('spinbutton')
    fireEvent.change(input, { target: { value: '50' } })
    fireEvent.blur(input)

    await waitFor(() => {
      const calls = fetchMock.mock.calls
      const patchCall = calls.find(
        (c) =>
          typeof c[0] === 'string' &&
          c[0].includes('/api/external-order-items/101') &&
          (c[1] as RequestInit)?.method === 'PATCH',
      )
      expect(patchCall).toBeDefined()
      const body = JSON.parse((patchCall![1] as RequestInit).body as string)
      expect(body).toHaveProperty('businessUseOverride', 50)
    })
  })

  it('does not render anything when open is false', () => {
    render(
      <ReceiptItemsDrawer
        open={false}
        onClose={vi.fn()}
        receipts={[RECEIPT_WITH_ORDER]}
        categoryHints={CATEGORY_HINTS}
        onExtract={vi.fn()}
      />,
    )

    expect(screen.queryByText('Eggs')).not.toBeInTheDocument()
    expect(screen.queryByText('Subtotal')).not.toBeInTheDocument()
  })
})
