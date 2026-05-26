import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PartnerFairnessPage } from './PartnerFairnessPage'

const FAIRNESS_PAYLOAD = {
  byCurrency: [
    {
      currency: 'CAD',
      sharedSpendTotal: -800,
      myShareTotal: -400,
      partnerShareTotal: -400,
      sharedTransactionCount: 3,
      currentMonthSharedSpend: 300,
      balance: -400,
      direction: 'i_owe_partner',
      paidMore: { youCovered: 400, partnerCovered: 0 },
      categoryBreakdown: [
        { category: 'Groceries', sharedSpend: -500, myShare: -250, partnerShare: -250, transactionCount: 2 },
        { category: 'Dining', sharedSpend: -300, myShare: -150, partnerShare: -150, transactionCount: 1 },
      ],
      largestShared: [
        {
          txnId: 101,
          date: '2027-05-12',
          merchant: 'Joint Rent',
          category: 'Housing',
          amount: -400,
          myShare: -200,
          partnerShare: -200,
          ownershipType: 'shared',
          ownershipContactId: null,
          contactName: null,
        },
      ],
    },
  ],
}

const MONTHLY_PAYLOAD = {
  points: [
    {
      month: '2027-04',
      currency: 'CAD',
      sharedSpend: -200,
      myShare: -100,
      partnerShare: -100,
      settlementDelta: 0,
      netDelta: -100,
      cumulativeBalance: -100,
    },
    {
      month: '2027-05',
      currency: 'CAD',
      sharedSpend: -600,
      myShare: -300,
      partnerShare: -300,
      settlementDelta: 0,
      netDelta: -300,
      cumulativeBalance: -400,
    },
  ],
}

const RECOMMENDATION_PAYLOAD = {
  recommendations: [
    {
      currency: 'CAD',
      amount: 400,
      direction: 'you_pay_partner',
      outstandingBalance: -400,
    },
  ],
}

function mockFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo) => {
      const url = String(input)
      if (url.includes('/api/partner/fairness')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(FAIRNESS_PAYLOAD) } as Response)
      }
      if (url.includes('/api/partner/monthly')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MONTHLY_PAYLOAD) } as Response)
      }
      if (url.includes('/api/partner/settlement-recommendation')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(RECOMMENDATION_PAYLOAD),
        } as Response)
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response)
    }),
  )
}

describe('PartnerFairnessPage', () => {
  beforeEach(() => {
    mockFetch()
  })

  it('renders heading and currency section', async () => {
    render(
      <MemoryRouter>
        <PartnerFairnessPage />
      </MemoryRouter>,
    )
    expect(screen.getByText('Partner fairness')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('CAD')).toBeInTheDocument())
  })

  it('renders the running-balance stat with the "you owe partner" hint', async () => {
    render(
      <MemoryRouter>
        <PartnerFairnessPage />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('Running balance')).toBeInTheDocument())
    expect(screen.getByText('You owe partner')).toBeInTheDocument()
  })

  it('renders the settlement recommendation', async () => {
    render(
      <MemoryRouter>
        <PartnerFairnessPage />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('You pay partner')).toBeInTheDocument())
  })

  it('renders the category breakdown rows', async () => {
    render(
      <MemoryRouter>
        <PartnerFairnessPage />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('Groceries')).toBeInTheDocument())
    expect(screen.getByText('Dining')).toBeInTheDocument()
  })

  it('renders the monthly trend rows', async () => {
    render(
      <MemoryRouter>
        <PartnerFairnessPage />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('2027-04')).toBeInTheDocument())
    expect(screen.getByText('2027-05')).toBeInTheDocument()
  })

  it('renders the largest shared transaction with a deep-link to transactions', async () => {
    render(
      <MemoryRouter>
        <PartnerFairnessPage />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('Joint Rent')).toBeInTheDocument())
    const link = screen.getByText('Joint Rent').closest('a')
    expect(link).not.toBeNull()
    expect(link?.getAttribute('href')).toBe('/transactions?merchant=Joint%20Rent')
  })

  it('shows the empty-state when no currency data is returned', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo) => {
        const url = String(input)
        if (url.includes('/api/partner/fairness')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ byCurrency: [] }) } as Response)
        }
        if (url.includes('/api/partner/monthly')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ points: [] }) } as Response)
        }
        if (url.includes('/api/partner/settlement-recommendation')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ recommendations: [] }) } as Response)
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response)
      }),
    )
    render(
      <MemoryRouter>
        <PartnerFairnessPage />
      </MemoryRouter>,
    )
    await waitFor(() =>
      expect(screen.getByText(/No shared activity yet/i)).toBeInTheDocument(),
    )
  })
})
