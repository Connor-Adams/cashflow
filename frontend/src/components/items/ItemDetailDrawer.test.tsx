import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ItemDetailDrawer } from './ItemDetailDrawer'
import * as api from '@/lib/api'
import type { ItemRow } from '@cashflow/shared'

void React

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, getJson: vi.fn(), patchJson: vi.fn() }
})

const sampleAlloc = {
  itemId: 1,
  itemTotal: 19,
  allocatedTotal: 19.99,
  categoryBucket: 'Office',
  txnId: 100,
  txnAmount: 42.18,
  percentOfTxn: 47.4,
  linkedTxnIds: [100],
}

function sampleItem(overrides: Partial<ItemRow> = {}): ItemRow {
  return {
    id: 1,
    title: 'USB-C',
    qty: 2,
    unitPrice: 9.5,
    totalPrice: 19,
    taxShare: 0,
    categoryEffective: 'Office',
    categoryOverride: null,
    businessUseEffective: true,
    businessUseOverride: null,
    order: { id: 1, vendor: 'amazon' },
    receipt: { id: 1, date: '2026-05-20', sourceTxnId: 100 },
    ...overrides,
  }
}

describe('ItemDetailDrawer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders nothing when itemId is null', () => {
    const { container } = render(
      <ItemDetailDrawer itemId={null} item={null} onClose={() => {}} onPatched={() => {}} />,
    )
    expect(container.firstChild).toBe(null)
  })

  it('fetches and renders allocation when itemId is set', async () => {
    vi.mocked(api.getJson).mockResolvedValue(sampleAlloc)
    render(
      <ItemDetailDrawer
        itemId={1}
        item={sampleItem()}
        onClose={() => {}}
        onPatched={() => {}}
      />,
    )
    await waitFor(() => expect(screen.getByText(/USB-C/)).toBeInTheDocument())
    await waitFor(() => expect(screen.getByText(/19\.99/)).toBeInTheDocument())
    expect(screen.getByText(/47\.4%/)).toBeInTheDocument()
  })

  it('closes on Esc', async () => {
    const onClose = vi.fn()
    vi.mocked(api.getJson).mockResolvedValue(sampleAlloc)
    render(
      <ItemDetailDrawer
        itemId={1}
        item={sampleItem()}
        onClose={onClose}
        onPatched={() => {}}
      />,
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('PATCH on save', async () => {
    vi.mocked(api.getJson).mockResolvedValue(sampleAlloc)
    vi.mocked(api.patchJson).mockResolvedValue({})
    const onPatched = vi.fn()
    render(
      <ItemDetailDrawer
        itemId={1}
        item={sampleItem({ categoryOverride: 'Old', categoryEffective: 'Old' })}
        onClose={() => {}}
        onPatched={onPatched}
      />,
    )
    const input = await screen.findByLabelText(/category override/i)
    fireEvent.change(input, { target: { value: 'New' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(api.patchJson).toHaveBeenCalled())
    expect(onPatched).toHaveBeenCalled()
  })
})
