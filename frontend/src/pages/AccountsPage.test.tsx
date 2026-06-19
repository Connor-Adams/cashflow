import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ToastProvider } from '@/components/ui/toast'
import { AccountsPage } from './AccountsPage'
import { getJson } from '../lib/api'

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

  it('exposes a "Merge into…" action when a same-currency target exists (AC #11)', async () => {
    renderPage()
    await screen.findByText('Everyday Chequing')
    // Two CAD accounts → merge action present and enabled for both.
    const mergeButtons = screen.getAllByRole('button', { name: /merge into/i })
    expect(mergeButtons.length).toBeGreaterThan(0)
    expect(mergeButtons[0]).toBeEnabled()
    // Clicking opens the modal.
    fireEvent.click(mergeButtons[0])
    expect(await screen.findByText('Merge accounts')).toBeInTheDocument()
  })

  it('renders merged sources in the "Hidden / merged accounts" section (AC #13)', async () => {
    vi.mocked(getJson).mockResolvedValueOnce([
      {
        id: 1, name: 'New BoA', owner: 'me', householdId: null, ownerUserId: null,
        accountType: 'checking', shortCode: null, defaultCurrency: 'CAD', visibility: 'shared',
        closedAt: null, creditLimit: null, currentBalance: null, utilizationPct: null, notes: null,
        mergedIntoId: null, mergedAt: null,
      },
      {
        id: 2, name: 'Old BoA', owner: 'me', householdId: null, ownerUserId: null,
        accountType: 'checking', shortCode: null, defaultCurrency: 'CAD', visibility: 'shared',
        closedAt: null, creditLimit: null, currentBalance: null, utilizationPct: null, notes: null,
        mergedIntoId: 1, mergedAt: '2026-06-19T12:00:00.000Z',
      },
    ])
    renderPage()
    // Section heading is present (collapsible, collapsed by default).
    const heading = await screen.findByText('Hidden / merged accounts')
    expect(heading).toBeInTheDocument()
    // Expand the section to reveal its rows.
    fireEvent.click(screen.getByRole('button', { name: /expand hidden \/ merged accounts/i }))
    // The merged source name appears in the hidden section, with its target.
    expect(await screen.findByText('Old BoA')).toBeInTheDocument()
    // "New BoA" is both the active row and the "Merged into" cell value.
    expect(screen.getAllByText('New BoA').length).toBeGreaterThan(0)
  })
})
