import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ToastProvider } from '@/components/ui/toast'
import { ReportsPage } from './ReportsPage'
import { getJson } from '../lib/api'

// Minimally-valid mock shapes for each endpoint ReportsPage fetches.
// getJson branches on the URL substring; postJson/deleteReq are stubs.
vi.mock('../lib/api', () => ({
  getJson: vi.fn((url: string) => {
    if (url.includes('/api/summary/partner')) {
      return Promise.resolve({
        byCurrency: [
          {
            currency: 'CAD',
            ownershipType: 'shared',
            ownershipContactId: null,
            contactName: null,
            sumMy: 100,
            sumPartner: 50,
            rawNet: -50,
            settledAmount: 0,
            settlementCount: 0,
            net: -50,
            direction: 'i_owe_partner',
          },
        ],
      })
    }
    if (url.includes('/api/summary/business')) {
      return Promise.resolve({
        byCurrency: [{ currency: 'CAD', sumBusiness: 200 }],
      })
    }
    if (url.includes('/api/summary/dashboard')) {
      return Promise.resolve({
        merchantSummaries: [],
        accountSummaries: [],
      })
    }
    if (url.includes('/api/contacts')) {
      return Promise.resolve([
        { id: 1, householdId: 1, name: 'Alex', notes: null, isPartner: true },
      ])
    }
    if (url.includes('/api/settlements')) {
      return Promise.resolve({
        data: [
          {
            id: 1,
            householdId: 1,
            contactId: 1,
            contactName: 'Alex',
            direction: 'i_paid_partner',
            currency: 'CAD',
            amount: '75.00',
            settledDate: '2026-01-15',
            notes: null,
            createdAt: '2026-01-15T00:00:00.000Z',
            updatedAt: '2026-01-15T00:00:00.000Z',
          },
        ],
      })
    }
    return Promise.resolve({})
  }),
  postJson: vi.fn(() => Promise.resolve({})),
  deleteReq: vi.fn(() => Promise.resolve(undefined)),
}))

function renderPage() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <ReportsPage />
      </ToastProvider>
    </MemoryRouter>,
  )
}

describe('ReportsPage', () => {
  it('renders the page heading', async () => {
    renderPage()
    expect(
      await screen.findByRole('heading', { name: /reports/i, level: 1 }),
    ).toBeInTheDocument()
  })

  it('renders the stat card labels', async () => {
    renderPage()
    // 'My share' appears both as a stat-card label and as a table column header;
    // use findAllByText and assert at least one instance is present.
    const myShareEls = await screen.findAllByText('My share')
    expect(myShareEls.length).toBeGreaterThan(0)
    expect(screen.getAllByText('Partner share').length).toBeGreaterThan(0)
  })

  it('renders the Record settlement button', async () => {
    renderPage()
    expect(
      await screen.findByRole('button', { name: /record settlement/i }),
    ).toBeInTheDocument()
  })

  it('renders a settlement row from the fetched data', async () => {
    renderPage()
    // The settlement table renders the contactName from the mock data
    expect(await screen.findByText('Alex')).toBeInTheDocument()
  })

  it('renders skeletons while loading', () => {
    // Pin loading=true by making getJson never resolve, then restore the
    // route-aware default so sibling tests keep their resolved fixtures.
    const original = vi.mocked(getJson).getMockImplementation()
    vi.mocked(getJson).mockImplementation(() => new Promise(() => {}))
    try {
      const { container } = renderPage()
      expect(
        container.querySelectorAll('[data-slot="skeleton"]').length,
      ).toBeGreaterThan(0)
    } finally {
      vi.mocked(getJson).mockImplementation(original!)
    }
  })
})
