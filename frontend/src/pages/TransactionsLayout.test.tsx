import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { TransactionsLayout } from './TransactionsLayout'

void React

const TABS = ['All', 'Refunds', 'Transfers', 'Purchases', 'Large', 'Returns', 'Items', 'Search', 'Leaks']

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/transactions" element={<TransactionsLayout />}>
          <Route index element={<div>all-body</div>} />
          <Route path="refunds" element={<div>refunds-body</div>} />
          <Route path="leaks" element={<div>leaks-body</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

describe('TransactionsLayout (PR 1)', () => {
  it('renders all nine tabs and the All index body', () => {
    renderAt('/transactions')
    for (const name of TABS) {
      expect(screen.getByRole('tab', { name })).toBeInTheDocument()
    }
    expect(screen.getByText('all-body')).toBeInTheDocument()
  })

  it('marks the active tab from the URL', () => {
    renderAt('/transactions/refunds')
    expect(screen.getByRole('tab', { name: 'Refunds' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('refunds-body')).toBeInTheDocument()
  })

  it('navigates on tab click', async () => {
    renderAt('/transactions')
    await userEvent.click(screen.getByRole('tab', { name: 'Leaks' }))
    expect(screen.getByText('leaks-body')).toBeInTheDocument()
  })
})
