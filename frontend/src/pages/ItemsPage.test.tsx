import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { ItemsPage } from './ItemsPage'
import * as api from '@/lib/api'

void React

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

  it('analyze tab renders coming-soon placeholder', () => {
    renderAt('/items?tab=analyze')
    expect(screen.getByText(/coming soon/i)).toBeInTheDocument()
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
})
