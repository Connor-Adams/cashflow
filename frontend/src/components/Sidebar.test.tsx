import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Sidebar } from './Sidebar'

void React

vi.mock('../lib/useAuth', () => ({
  useAuth: () => ({ user: { displayName: 'Tester', globalRole: null }, logout: vi.fn() }),
}))
vi.mock('../hooks/useTheme', () => ({
  useTheme: () => ({ theme: 'light', toggleTheme: vi.fn() }),
}))
vi.mock('@/hooks/useAiInboxCount', () => ({ useAiInboxCount: () => ({ count: 0 }) }))
vi.mock('@/hooks/useInsightsCount', () => ({ useInsightsCount: () => ({ count: 0 }) }))
vi.mock('@/hooks/useAiStatus', () => ({ useAiStatus: () => ({ openai: true }) }))
vi.mock('../lib/version', () => ({
  FRONTEND_VERSION: 'test',
  useBackendVersion: () => ({ status: 'ok', version: 'test' }),
}))

function renderSidebar() {
  return render(
    <MemoryRouter>
      <Sidebar open={false} onClose={() => {}} />
    </MemoryRouter>,
  )
}

describe('Sidebar rail (PR 0)', () => {
  it('drops items folded elsewhere', () => {
    renderSidebar()
    for (const name of [
      'Ask Cashflow',
      'Audit log',
      'Backup & sync',
      'Explain month',
      'Lifestyle inflation',
      'Savings rate',
    ]) {
      expect(screen.queryByRole('link', { name })).not.toBeInTheDocument()
    }
  })

  it('relocates Amazon into the Money section', () => {
    // Credit cards was also relocated here in PR 0, then folded into the
    // Accounts tabs in PR 3 (asserted absent below).
    renderSidebar()
    const moneyHeader = screen.getByRole('button', { name: /Money/ })
    const moneySection = moneyHeader.closest('.sidebar__section') as HTMLElement
    expect(within(moneySection).getByRole('link', { name: 'Amazon' })).toBeInTheDocument()
  })

  it('keeps Chat reachable (Ask folds into it)', () => {
    renderSidebar()
    expect(screen.getByRole('link', { name: 'Chat' })).toBeInTheDocument()
  })

  it('drops the Transaction-family items folded into /transactions tabs (PR 1)', () => {
    renderSidebar()
    for (const name of [
      'Refunds',
      'Transfers',
      'Purchases',
      'Large purchases',
      'Returns & warranties',
      'Items',
      'Smart search',
      'Money leaks',
    ]) {
      expect(screen.queryByRole('link', { name })).not.toBeInTheDocument()
    }
    expect(screen.getByRole('link', { name: 'Transactions' })).toBeInTheDocument()
  })

  it('drops the items folded into Accounts/Scenarios/Portfolio tabs (PR 3)', () => {
    renderSidebar()
    for (const name of ['Credit cards', 'Statements', 'Debt payoff', 'Opportunity cost', 'Net worth', 'Tax']) {
      expect(screen.queryByRole('link', { name })).not.toBeInTheDocument()
    }
    for (const name of ['Accounts', 'Scenarios', 'Portfolio']) {
      expect(screen.getByRole('link', { name })).toBeInTheDocument()
    }
  })
})
