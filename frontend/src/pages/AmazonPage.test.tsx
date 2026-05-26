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
