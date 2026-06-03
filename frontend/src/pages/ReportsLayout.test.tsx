import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { ReportsLayout } from './ReportsLayout'

void React

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/reports" element={<ReportsLayout />}>
          <Route index element={<div>summary-body</div>} />
          <Route path="explain-month" element={<div>explain-body</div>} />
          <Route path="lifestyle-inflation" element={<div>lifestyle-body</div>} />
          <Route path="savings-rate" element={<div>savings-body</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

describe('ReportsLayout (PR 0)', () => {
  it('renders four report tabs and the summary child at /reports', () => {
    renderAt('/reports')
    for (const name of ['Summary', 'Explain month', 'Lifestyle inflation', 'Savings rate']) {
      expect(screen.getByRole('tab', { name })).toBeInTheDocument()
    }
    expect(screen.getByText('summary-body')).toBeInTheDocument()
  })

  it('marks the active tab from the URL', () => {
    renderAt('/reports/explain-month')
    expect(screen.getByRole('tab', { name: 'Explain month' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(screen.getByText('explain-body')).toBeInTheDocument()
  })

  it('navigates when a tab is clicked', async () => {
    renderAt('/reports')
    await userEvent.click(screen.getByRole('tab', { name: 'Savings rate' }))
    expect(screen.getByText('savings-body')).toBeInTheDocument()
  })

  it('exposes the folded Partner, Currency, and Cashflow tabs (PR 4)', () => {
    renderAt('/reports')
    for (const name of ['Partner', 'Currency', 'Cashflow']) {
      expect(screen.getByRole('tab', { name })).toBeInTheDocument()
    }
  })
})
