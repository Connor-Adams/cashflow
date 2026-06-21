import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { TransactionsLayout } from './TransactionsLayout'
import { RefundsReviewPage } from './RefundsReviewPage'
import * as api from '@/lib/api'
import { ToastProvider } from '@/components/ui/toast'

void React

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, getJson: vi.fn(), postJson: vi.fn(), deleteReq: vi.fn() }
})

beforeEach(() => {
  vi.mocked(api.getJson).mockResolvedValue({ data: [], suggestions: [] } as never)
})

function renderAt(path: string) {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/transactions" element={<TransactionsLayout />}>
            <Route index element={<div>all-ledger</div>} />
            <Route path="refunds" element={<RefundsReviewPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  )
}

describe('transactions routing (PR 1)', () => {
  it('/transactions renders the All tab + tab bar', () => {
    renderAt('/transactions')
    expect(screen.getByRole('tab', { name: 'All' })).toBeInTheDocument()
    expect(screen.getByText('all-ledger')).toBeInTheDocument()
  })

  it('/transactions/refunds mounts the Refunds page under the same tab bar', () => {
    renderAt('/transactions/refunds')
    expect(screen.getByRole('tab', { name: 'Refunds' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('heading', { name: /refunds review/i })).toBeInTheDocument()
  })
})
