import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { AccountsLayout } from './RouteTabsLayout'
import { AccountsPage } from './AccountsPage'
import * as api from '@/lib/api'
import { ToastProvider } from '@/components/ui/toast'

void React

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, getJson: vi.fn(), postJson: vi.fn(), patchJson: vi.fn(), deleteReq: vi.fn() }
})

beforeEach(() => {
  vi.mocked(api.getJson).mockResolvedValue([] as never)
})

function renderAt(path: string) {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/accounts" element={<AccountsLayout />}>
            <Route index element={<AccountsPage />} />
            <Route path="credit-cards" element={<div>cc-marker</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  )
}

describe('accounts routing (PR 3)', () => {
  it('/accounts renders the Balances tab + the Accounts page under the layout', async () => {
    renderAt('/accounts')
    expect(screen.getByRole('tab', { name: 'Balances' })).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: 'Accounts' })).toBeInTheDocument(),
    )
  })

  it('/accounts/credit-cards activates the Credit cards tab', () => {
    renderAt('/accounts/credit-cards')
    expect(screen.getByRole('tab', { name: 'Credit cards' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(screen.getByText('cc-marker')).toBeInTheDocument()
  })
})
