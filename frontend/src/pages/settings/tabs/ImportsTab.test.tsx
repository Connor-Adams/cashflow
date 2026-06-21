import React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
import { ImportsTab } from './ImportsTab'
import { formatMoney } from '../../../lib/formatMoney'

const receiptImportResult = {
  order: { id: 1, vendor: 'costco', total: '123.4', currency: 'CAD', orderDate: '2026-06-01' },
  created: true,
  extracted: {
    vendor: 'costco',
    vendorName: 'Costco',
    orderDate: '2026-06-01',
    orderId: null,
    total: 123.4,
    currency: 'CAD',
    paymentLast4: null,
    tenders: [
      { paymentLast4: '1234', network: 'visa', amount: 100 },
      { paymentLast4: null, network: null, amount: 23.4 },
    ],
    items: [],
    notes: null,
  },
}

vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) =>
  Promise.resolve({
    ok: true,
    json: () =>
      Promise.resolve(
        String(input).includes('/api/external-orders/import-text')
          ? receiptImportResult
          : {},
      ),
  } as Response),
))

describe('ImportsTab', () => {
  it('renders both Import receipts and Receipt capture headings', () => {
    render(<ImportsTab />)
    expect(screen.getByRole('heading', { name: /import receipts/i })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /receipt capture/i })).toBeInTheDocument()
  })

  it('formats the parsed receipt total and split-tender amounts as money', async () => {
    const user = userEvent.setup()
    render(<ImportsTab />)
    await user.type(
      screen.getByLabelText(/paste receipt email body/i),
      'Order ID 123',
    )
    await user.click(screen.getByRole('button', { name: /parse pasted text/i }))

    // "123.4 CAD" raw is not a money rendering — the total must go through
    // formatMoney like the line items below it already do.
    const summary = await screen.findByText(/Created/)
    expect(summary.parentElement?.textContent).toContain(formatMoney(123.4, 'CAD'))
    expect(summary.parentElement?.textContent).not.toContain('123.4 CAD')

    const splitTender = screen.getByText(/Split tender:/)
    expect(splitTender.textContent).toContain(formatMoney(100, 'CAD'))
    expect(splitTender.textContent).toContain(formatMoney(23.4, 'CAD'))
  })
})
