import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { ItemsPage } from './ItemsPage'
import * as api from '@/lib/api'
import type { ItemRow } from '@cashflow/shared'

void React

function itemRow(overrides: Partial<ItemRow> = {}): ItemRow {
  return {
    id: 1,
    title: 'Widget',
    qty: 1,
    unitPrice: 5,
    totalPrice: 5,
    currency: 'CAD',
    taxShare: 0,
    categoryEffective: null,
    categoryOverride: null,
    businessUseEffective: false,
    businessUseOverride: null,
    order: { id: 10, vendor: 'amazon', cardOwnership: 'known' },
    receipt: { id: 100, date: '2026-05-01', sourceTxnId: 1000 },
    ...overrides,
  }
}

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, getJson: vi.fn(), patchJson: vi.fn() }
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.getJson).mockResolvedValue({ items: [], nextCursor: null })
})

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/items" element={<ItemsPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('ItemsPage', () => {
  it('renders three tabs with Browse default', () => {
    renderAt('/items')
    expect(screen.getByRole('tab', { name: /browse/i })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: /analyze/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /search/i })).toBeInTheDocument()
  })

  it('honors ?tab=search', () => {
    renderAt('/items?tab=search')
    expect(screen.getByRole('tab', { name: /search/i })).toHaveAttribute('aria-selected', 'true')
  })

  it('analyze tab renders the analytics view', async () => {
    vi.mocked(api.getJson).mockResolvedValue({
      topItems: [],
      byBrand: [],
      currencyUsed: 'CAD',
      currencyOthers: [],
    })
    renderAt('/items?tab=analyze')
    expect(screen.getByRole('tab', { name: /analyze/i })).toHaveAttribute('aria-selected', 'true')
    expect(await screen.findByText(/no item-level data yet/i)).toBeInTheDocument()
    expect(screen.queryByText(/coming soon/i)).not.toBeInTheDocument()
  })

  it('filter chip change refetches', async () => {
    renderAt('/items')
    await waitFor(() => expect(api.getJson).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: /^vendor$/i }))
    fireEvent.change(screen.getByPlaceholderText(/vendor name/i), { target: { value: 'amazon' } })
    fireEvent.click(screen.getAllByRole('button', { name: /apply/i })[0])
    await waitFor(() =>
      expect(api.getJson).toHaveBeenLastCalledWith(expect.stringContaining('vendor=amazon')),
    )
  })

  it('shows the "No items yet" EmptyState with an Import CTA when there is no data and no filters (#799)', async () => {
    renderAt('/items')
    expect(await screen.findByText('No items yet')).toBeInTheDocument()
    const cta = screen.getByRole('link', { name: /import a statement/i })
    expect(cta).toHaveAttribute('href', '/import')
  })

  it('shows the "Nothing matches this filter" EmptyState with a Clear filters CTA when a filter excludes everything (#799)', async () => {
    renderAt('/items?vendor=Costco')
    expect(await screen.findByText('Nothing matches this filter')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /clear filters/i })).toBeInTheDocument()
  })

  describe('card ownership badges', () => {
    it('badges an item whose order card is unverified', async () => {
      vi.mocked(api.getJson).mockResolvedValue({
        items: [itemRow({ order: { id: 10, vendor: 'amazon', cardOwnership: 'unknown' } })],
        nextCursor: null,
      })
      renderAt('/items')
      expect(await screen.findByText(/unverified card/i)).toBeInTheDocument()
    })

    it('renders no badge for a known card', async () => {
      vi.mocked(api.getJson).mockResolvedValue({
        items: [itemRow({ order: { id: 10, vendor: 'amazon', cardOwnership: 'known' } })],
        nextCursor: null,
      })
      renderAt('/items')
      await screen.findByText('Widget')
      expect(screen.queryByText(/unverified card/i)).not.toBeInTheDocument()
      expect(screen.queryByText(/not your card/i)).not.toBeInTheDocument()
    })
  })
})
