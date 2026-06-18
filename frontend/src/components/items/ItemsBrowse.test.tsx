import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ItemsBrowse } from './ItemsBrowse'
import * as api from '@/lib/api'
import type { ItemRow } from '@cashflow/shared'

void React

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, getJson: vi.fn(), patchJson: vi.fn() }
})

const sample: ItemRow[] = [
  {
    id: 1,
    title: 'A',
    qty: 1,
    unitPrice: 5,
    totalPrice: 5,
    taxShare: 0,
    categoryEffective: 'Office',
    categoryOverride: null,
    businessUseEffective: true,
    businessUseOverride: null,
    order: { id: 10, vendor: 'amazon' },
    receipt: { id: 100, date: '2026-05-20', sourceTxnId: 1000 },
  },
  {
    id: 2,
    title: 'B',
    qty: 1,
    unitPrice: 5,
    totalPrice: 5,
    taxShare: 0,
    categoryEffective: 'Office',
    categoryOverride: null,
    businessUseEffective: true,
    businessUseOverride: null,
    order: { id: 10, vendor: 'amazon' },
    receipt: { id: 100, date: '2026-05-20', sourceTxnId: 1000 },
  },
  {
    id: 3,
    title: 'C',
    qty: 1,
    unitPrice: 5,
    totalPrice: 5,
    taxShare: 0,
    categoryEffective: 'Grocery',
    categoryOverride: null,
    businessUseEffective: false,
    businessUseOverride: null,
    order: { id: 11, vendor: 'costco' },
    receipt: { id: 101, date: '2026-05-19', sourceTxnId: 1001 },
  },
]

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.getJson).mockResolvedValue({ items: sample, nextCursor: null })
  vi.mocked(api.patchJson).mockResolvedValue({} as never)
})

async function selectFirstTwo() {
  await waitFor(() => expect(screen.getByLabelText(/Select item A/)).toBeInTheDocument())
  const checkboxes = screen.getAllByRole('checkbox', { name: /select item/i })
  fireEvent.click(checkboxes[0])
  fireEvent.click(checkboxes[1])
}

describe('ItemsBrowse', () => {
  it('renders grouped by purchase with group headers', async () => {
    render(<ItemsBrowse filters={{}} onOpenItem={() => {}} />)
    await waitFor(() => expect(screen.getByText(/amazon/i)).toBeInTheDocument())
    expect(screen.getByText(/^3 items$/)).toBeInTheDocument()
  })

  it('toggles group-by mode', async () => {
    render(<ItemsBrowse filters={{}} onOpenItem={() => {}} />)
    await waitFor(() => expect(screen.getByText(/amazon/i)).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /group by/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: /category/i }))
    expect(screen.getAllByRole('heading', { name: /Office/ }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('heading', { name: /Grocery/ }).length).toBeGreaterThan(0)
  })

  it('multi-select shows toolbar with count', async () => {
    render(<ItemsBrowse filters={{}} onOpenItem={() => {}} />)
    await waitFor(() => expect(screen.getByLabelText(/Select item A/)).toBeInTheDocument())
    const checkboxes = screen.getAllByRole('checkbox', { name: /select item/i })
    fireEvent.click(checkboxes[0])
    fireEvent.click(checkboxes[1])
    expect(screen.getByText(/2 selected/i)).toBeInTheDocument()
  })

  it('Set category opens a dialog populated from existing category hints', async () => {
    render(<ItemsBrowse filters={{}} onOpenItem={() => {}} />)
    await selectFirstTwo()
    fireEvent.click(screen.getByRole('button', { name: /set category/i }))
    const dialog = await screen.findByRole('dialog')
    const select = screen.getByLabelText('Category') as HTMLSelectElement
    // Options come from the loaded items' categories, plus a clear option.
    const optionLabels = Array.from(select.options).map((o) => o.textContent)
    expect(optionLabels).toEqual(
      expect.arrayContaining(['— Clear category (uncategorized)', 'Grocery', 'Office'])
    )
    expect(dialog).toBeInTheDocument()
    expect(api.patchJson).not.toHaveBeenCalled()
  })

  it('applying a chosen category PATCHes bulk-patch, clears selection, fires callback', async () => {
    const onItemsPatched = vi.fn()
    render(<ItemsBrowse filters={{}} onOpenItem={() => {}} onItemsPatched={onItemsPatched} />)
    await selectFirstTwo()
    fireEvent.click(screen.getByRole('button', { name: /set category/i }))
    await screen.findByRole('dialog')
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'Grocery' } })
    fireEvent.click(screen.getByRole('button', { name: /^apply$/i }))
    await waitFor(() =>
      expect(api.patchJson).toHaveBeenCalledWith('/api/external-order-items/bulk-patch', {
        itemIds: [1, 2],
        categoryOverride: 'Grocery',
      })
    )
    await waitFor(() => expect(onItemsPatched).toHaveBeenCalledTimes(1))
    // Selection cleared → toolbar gone, dialog closed.
    expect(screen.queryByText(/selected/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('selecting the clear option sends categoryOverride null', async () => {
    render(<ItemsBrowse filters={{}} onOpenItem={() => {}} />)
    await selectFirstTwo()
    fireEvent.click(screen.getByRole('button', { name: /set category/i }))
    await screen.findByRole('dialog')
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: /^apply$/i }))
    await waitFor(() =>
      expect(api.patchJson).toHaveBeenCalledWith('/api/external-order-items/bulk-patch', {
        itemIds: [1, 2],
        categoryOverride: null,
      })
    )
  })

  it('Cancel closes the dialog without patching and keeps selection', async () => {
    render(<ItemsBrowse filters={{}} onOpenItem={() => {}} />)
    await selectFirstTwo()
    fireEvent.click(screen.getByRole('button', { name: /set category/i }))
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.patchJson).not.toHaveBeenCalled()
    expect(screen.getByText(/2 selected/i)).toBeInTheDocument()
  })

  it('row click invokes onOpenItem with row', async () => {
    const onOpen = vi.fn()
    render(<ItemsBrowse filters={{}} onOpenItem={onOpen} />)
    await waitFor(() => expect(screen.getByText(/^A$/)).toBeInTheDocument())
    fireEvent.click(screen.getByText(/^A$/))
    expect(onOpen).toHaveBeenCalledWith(1, expect.objectContaining({ id: 1 }))
  })
})
