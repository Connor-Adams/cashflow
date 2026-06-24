// fallow-ignore-file code-duplication
// Per-test mock setup blocks repeat similar getJson stubs intentionally:
// each test exercises a distinct UI state and the inline mock makes the
// fixture self-contained and readable without shared-state coupling.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AmazonPage } from './AmazonPage'
import * as api from '@/lib/api'

void React

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getJson: vi.fn(),
    patchJson: vi.fn(),
    postJson: vi.fn(),
    postFormData: vi.fn(),
    deleteReq: vi.fn(),
  }
})

const ORDER = {
  id: 10,
  vendorOrderId: 'ORD-1',
  orderDate: '2026-05-01',
  shipmentDate: null,
  total: '50.00',
  currency: 'CAD',
  paymentLast4: '1234',
  source: 'amazon',
  items: [
    {
      id: 100,
      title: 'Widget',
      quantity: 1,
      unitPrice: '10.00',
      totalPrice: '10.00',
      inferredCategory: 'Home',
      businessUsePercent: '0',
      confidence: '90',
    },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.getJson).mockImplementation(async (path: string) => {
    if (path.startsWith('/api/amazon/orders?')) return [ORDER]
    if (path === '/api/amazon/review-transactions') return []
    if (path === '/api/amazon/categories') return { categories: ['Home', 'Office'] }
    if (path === '/api/ai/status') return { openai: false }
    if (path.startsWith('/api/amazon/orders/')) return ORDER
    return null
  })
})

async function openOrderRow(user: ReturnType<typeof userEvent.setup>) {
  // Wait for the order list to render and click View/Edit to open the item editor.
  await screen.findByText('ORD-1')
  const buttons = await screen.findAllByRole('button', { name: /view\/edit/i })
  await user.click(buttons[0])
}

describe('AmazonPage characterization', () => {
  it('renders the page h1 heading', async () => {
    render(<AmazonPage />)
    expect(await screen.findByRole('heading', { level: 1, name: 'Amazon Enrichment' })).toBeInTheDocument()
  })

  it('renders the Recent Imported Orders table with Order, Date, and Total column headers', async () => {
    render(<AmazonPage />)
    // Wait for orders to load (the order ID cell appears once data arrives).
    await screen.findByText('ORD-1')
    expect(screen.getByRole('columnheader', { name: 'Order' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Date' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Total' })).toBeInTheDocument()
  })

  it('renders the order row with the vendor order ID', async () => {
    render(<AmazonPage />)
    expect(await screen.findByRole('cell', { name: 'ORD-1' })).toBeInTheDocument()
  })
})

const SUGGESTED_LINK_ORDER = {
  id: 20,
  vendorOrderId: 'ORD-SUGGEST',
  orderDate: '2026-05-10',
  shipmentDate: null,
  total: '80.00',
  currency: 'CAD',
  paymentLast4: '5678',
  source: 'amazon',
  items: [
    {
      id: 200,
      title: 'Suggested Gadget',
      quantity: 1,
      unitPrice: '80.00',
      totalPrice: '80.00',
      inferredCategory: 'Electronics',
      businessUsePercent: '0',
      confidence: '80',
    },
  ],
}

const TXN_WITH_SUGGESTED_LINK = {
  id: 42,
  date: '2026-05-10',
  merchantClean: 'Amazon.ca',
  amount: '80.00',
  currency: 'CAD',
  orderLinks: [
    {
      id: 77,
      confidence: '80',
      matchReason: 'amount match',
      status: 'suggested' as const,
      order: SUGGESTED_LINK_ORDER,
    },
  ],
}

describe('AmazonPage suggested link accept/reject', () => {
  it('renders Accept and Reject buttons for a suggested link', async () => {
    vi.mocked(api.getJson).mockImplementation(async (path: string) => {
      if (path.startsWith('/api/amazon/orders?')) return [ORDER]
      if (path === '/api/amazon/review-transactions') return [TXN_WITH_SUGGESTED_LINK]
      if (path === '/api/amazon/categories') return { categories: ['Home', 'Office'] }
      if (path === '/api/ai/status') return { openai: false }
      if (path.startsWith('/api/amazon/orders/')) return ORDER
      return null
    })

    render(<AmazonPage />)

    expect(await screen.findByRole('button', { name: /accept/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /reject/i })).toBeInTheDocument()
  })

  it('shows item titles from the suggested link order', async () => {
    vi.mocked(api.getJson).mockImplementation(async (path: string) => {
      if (path.startsWith('/api/amazon/orders?')) return [ORDER]
      if (path === '/api/amazon/review-transactions') return [TXN_WITH_SUGGESTED_LINK]
      if (path === '/api/amazon/categories') return { categories: ['Home', 'Office'] }
      if (path === '/api/ai/status') return { openai: false }
      if (path.startsWith('/api/amazon/orders/')) return ORDER
      return null
    })

    render(<AmazonPage />)

    expect(await screen.findByText(/Suggested Gadget/)).toBeInTheDocument()
  })

  it('clicking Accept calls postJson with the accept endpoint and removes the link row', async () => {
    const user = userEvent.setup()
    vi.mocked(api.getJson).mockImplementation(async (path: string) => {
      if (path.startsWith('/api/amazon/orders?')) return [ORDER]
      if (path === '/api/amazon/review-transactions') return [TXN_WITH_SUGGESTED_LINK]
      if (path === '/api/amazon/categories') return { categories: ['Home', 'Office'] }
      if (path === '/api/ai/status') return { openai: false }
      if (path.startsWith('/api/amazon/orders/')) return ORDER
      return null
    })
    vi.mocked(api.postJson).mockResolvedValue({ id: 77, status: 'accepted' })

    render(<AmazonPage />)

    const acceptBtn = await screen.findByRole('button', { name: /accept/i })
    await user.click(acceptBtn)

    await waitFor(() =>
      expect(vi.mocked(api.postJson)).toHaveBeenCalledWith('/api/amazon/links/77/accept'),
    )

    // Row should be removed optimistically
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /accept/i })).not.toBeInTheDocument(),
    )
  })

  it('does NOT show Accept/Reject for an accepted link', async () => {
    const txnWithAcceptedLink = {
      ...TXN_WITH_SUGGESTED_LINK,
      orderLinks: [{ ...TXN_WITH_SUGGESTED_LINK.orderLinks[0], status: 'accepted' as const }],
    }
    vi.mocked(api.getJson).mockImplementation(async (path: string) => {
      if (path.startsWith('/api/amazon/orders?')) return [ORDER]
      if (path === '/api/amazon/review-transactions') return [txnWithAcceptedLink]
      if (path === '/api/amazon/categories') return { categories: ['Home', 'Office'] }
      if (path === '/api/ai/status') return { openai: false }
      if (path.startsWith('/api/amazon/orders/')) return ORDER
      return null
    })

    render(<AmazonPage />)

    // Wait for the transaction to load
    await screen.findByText('Amazon.ca')

    expect(screen.queryByRole('button', { name: /^accept$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^reject$/i })).not.toBeInTheDocument()
  })
})

describe('AmazonPage totalPrice validation', () => {
  it('totalPrice input has min=0 and step=0.01', async () => {
    const user = userEvent.setup()
    render(<AmazonPage />)
    await openOrderRow(user)
    const input = await screen.findByLabelText(/item total price/i)
    expect(input).toHaveAttribute('min', '0')
    expect(input).toHaveAttribute('step', '0.01')
  })

  it('shows inline error and blocks save when totalPrice is negative', async () => {
    const user = userEvent.setup()
    render(<AmazonPage />)
    await openOrderRow(user)
    const input = await screen.findByLabelText(/item total price/i)
    await user.clear(input)
    await user.type(input, '-5')
    await waitFor(() =>
      expect(screen.getByText(/price can't be negative/i)).toBeInTheDocument(),
    )
    // No PATCH should have been issued for this negative value.
    const patchCalls = vi
      .mocked(api.patchJson)
      .mock.calls.filter((c) => String(c[0]).includes('/items/100'))
    // Each character typed could have been an attempted patch; verify none
    // of them carried a negative numeric totalPrice value.
    for (const call of patchCalls) {
      const body = call[1] as { totalPrice?: string } | undefined
      if (body && body.totalPrice != null) {
        const n = Number(body.totalPrice)
        expect(n).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('accepts totalPrice of 0 (free item)', async () => {
    const user = userEvent.setup()
    render(<AmazonPage />)
    await openOrderRow(user)
    const input = await screen.findByLabelText(/item total price/i)
    await user.clear(input)
    await user.type(input, '0')
    // No error should appear.
    expect(screen.queryByText(/price can't be negative/i)).not.toBeInTheDocument()
    await waitFor(() =>
      expect(
        vi.mocked(api.patchJson).mock.calls.some(
          (c) =>
            String(c[0]).includes('/items/100') &&
            (c[1] as { totalPrice?: string } | undefined)?.totalPrice === '0',
        ),
      ).toBe(true),
    )
  })
})
