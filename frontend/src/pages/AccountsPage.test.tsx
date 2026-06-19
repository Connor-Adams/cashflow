import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ToastProvider } from '@/components/ui/toast'
import { AccountsPage } from './AccountsPage'

vi.mock('../lib/api', () => ({
  getJson: vi.fn(() =>
    Promise.resolve([
      {
        id: 1,
        name: 'Everyday Chequing',
        owner: 'me',
        householdId: null,
        ownerUserId: null,
        accountType: 'checking',
        shortCode: 'CHQ',
        defaultCurrency: 'CAD',
        visibility: 'shared',
        closedAt: null,
        creditLimit: null,
        currentBalance: null,
        utilizationPct: null,
        notes: null,
      },
      {
        id: 2,
        name: 'RBC Royal Credit Line',
        owner: 'me',
        householdId: null,
        ownerUserId: null,
        accountType: 'loan',
        shortCode: 'LOC',
        defaultCurrency: 'CAD',
        visibility: 'shared',
        closedAt: null,
        creditLimit: 4000,
        currentBalance: 800,
        utilizationPct: 20,
        notes: null,
      },
    ]),
  ),
  postJson: vi.fn(() => Promise.resolve({})),
  patchJson: vi.fn(() => Promise.resolve({})),
  deleteReq: vi.fn(() => Promise.resolve(undefined)),
}))

function renderPage() {
  return render(
    <ToastProvider>
      <AccountsPage />
    </ToastProvider>,
  )
}

describe('AccountsPage', () => {
  it('renders the page header', async () => {
    renderPage()
    // The h1 "Accounts" is the page title; use level:1 to distinguish it from
    // the h2s "New account" and "Your accounts" which also match /accounts/i.
    expect(await screen.findByRole('heading', { name: /^accounts$/i, level: 1 })).toBeInTheDocument()
  })

  it('renders a fetched account row', async () => {
    renderPage()
    expect(await screen.findByText('Everyday Chequing')).toBeInTheDocument()
  })

  it('renders the table column headers', async () => {
    renderPage()
    expect(await screen.findByRole('columnheader', { name: /name/i })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: /default currency/i })).toBeInTheDocument()
  })

  it('shows the credit limit + utilization for a line of credit (loan)', async () => {
    renderPage()
    // Revolving credit (loan line of credit) renders balance / limit + badge.
    expect(await screen.findByText('RBC Royal Credit Line')).toBeInTheDocument()
    // balance / limit render as separate text nodes inside one span.
    expect(screen.getByText(/\$800/)).toBeInTheDocument()
    expect(screen.getByText(/\$4,000/)).toBeInTheDocument()
    expect(screen.getByText('20% used')).toBeInTheDocument()
  })
})
