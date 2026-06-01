import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { AccountsLayout, InboxLayout, PortfolioLayout, ScenariosLayout } from './RouteTabsLayout'

void React

function mountAccounts(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/accounts" element={<AccountsLayout />}>
          <Route index element={<div>balances-body</div>} />
          <Route path="credit-cards" element={<div>cc-body</div>} />
          <Route path="debt" element={<div>debt-body</div>} />
          <Route path="statements" element={<div>stmt-body</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

describe('RouteTabsLayout via AccountsLayout', () => {
  it('renders the 4 account tabs and the index body', () => {
    mountAccounts('/accounts')
    for (const name of ['Balances', 'Credit cards', 'Debt', 'Statements']) {
      expect(screen.getByRole('tab', { name })).toBeInTheDocument()
    }
    expect(screen.getByText('balances-body')).toBeInTheDocument()
  })

  it('marks the active tab from a nested URL', () => {
    mountAccounts('/accounts/credit-cards')
    expect(screen.getByRole('tab', { name: 'Credit cards' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('cc-body')).toBeInTheDocument()
  })

  it('navigates on tab click', async () => {
    mountAccounts('/accounts')
    await userEvent.click(screen.getByRole('tab', { name: 'Debt' }))
    expect(screen.getByText('debt-body')).toBeInTheDocument()
  })
})

describe('Scenario + Portfolio configs', () => {
  it('ScenariosLayout exposes 3 tabs', () => {
    render(
      <MemoryRouter initialEntries={['/scenarios']}>
        <Routes>
          <Route path="/scenarios" element={<ScenariosLayout />}>
            <Route index element={<div>s</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    )
    for (const name of ['Scenarios', 'Tax', 'Opportunity cost']) {
      expect(screen.getByRole('tab', { name })).toBeInTheDocument()
    }
  })

  it('PortfolioLayout keeps Positions active on a security drilldown', () => {
    render(
      <MemoryRouter initialEntries={['/portfolio/security/42']}>
        <Routes>
          <Route path="/portfolio" element={<PortfolioLayout />}>
            <Route index element={<div>p</div>} />
            <Route path="security/:id" element={<div>sec</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    )
    expect(screen.getByRole('tab', { name: 'Positions' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('sec')).toBeInTheDocument()
  })

  it('InboxLayout exposes Proposals + Transaction review and activates from URL (PR 5)', () => {
    render(
      <MemoryRouter initialEntries={['/inbox/review']}>
        <Routes>
          <Route path="/inbox" element={<InboxLayout />}>
            <Route index element={<div>proposals-body</div>} />
            <Route path="review" element={<div>review-body</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    )
    for (const name of ['Proposals', 'Transaction review']) {
      expect(screen.getByRole('tab', { name })).toBeInTheDocument()
    }
    expect(screen.getByRole('tab', { name: 'Transaction review' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('review-body')).toBeInTheDocument()
  })
})
