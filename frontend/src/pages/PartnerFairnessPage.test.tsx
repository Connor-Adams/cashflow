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
      partnerInflows: 500,
      nonPartnerInflows: 75,
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
  excludeNonPartnerInflows: true,
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
  excludeNonPartnerInflows: true,
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
  excludeNonPartnerInflows: true,
}

// #375 — base CashflowSettings response for the dashboard's first GET.
const SETTINGS_PAYLOAD = {
  minimumCashBuffer: '0.0000',
  safeToSpendWindowDays: 14,
  includeCreditCardBalance: true,
  includeGoalContributions: true,
  excludeNonPartnerInflows: true,
}

function mockFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo) => {
      const url = String(input)
      if (url.includes('/api/settings/cashflow')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(SETTINGS_PAYLOAD) } as Response)
      }
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
        if (url.includes('/api/settings/cashflow')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(SETTINGS_PAYLOAD) } as Response)
        }
        if (url.includes('/api/partner/fairness')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ byCurrency: [], excludeNonPartnerInflows: true }) } as Response)
        }
        if (url.includes('/api/partner/monthly')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ points: [], excludeNonPartnerInflows: true }) } as Response)
        }
        if (url.includes('/api/partner/settlement-recommendation')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ recommendations: [], excludeNonPartnerInflows: true }) } as Response)
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

  // ---------------- #375 toggle + partner inflows split ------------------

  it('renders the partner-inflows and non-partner-inflows tiles', async () => {
    render(
      <MemoryRouter>
        <PartnerFairnessPage />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('Partner inflows')).toBeInTheDocument())
    expect(screen.getByText('Non-partner inflows')).toBeInTheDocument()
  })

  it('shows the exclude-non-partner-inflows toggle', async () => {
    render(
      <MemoryRouter>
        <PartnerFairnessPage />
      </MemoryRouter>,
    )
    await waitFor(() =>
      expect(screen.getByText('Exclude non-partner inflows')).toBeInTheDocument(),
    )
    const checkbox = screen.getByRole('checkbox', {
      name: /exclude non-partner inflows/i,
    }) as HTMLInputElement
    expect(checkbox.checked).toBe(true)
  })

  it('persists the toggle via PATCH /api/settings/cashflow', async () => {
    const fetchMock = vi.fn((input: RequestInfo, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url.includes('/api/settings/cashflow') && method === 'GET') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(SETTINGS_PAYLOAD) } as Response)
      }
      if (url.includes('/api/settings/cashflow') && method === 'PATCH') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ...SETTINGS_PAYLOAD, excludeNonPartnerInflows: false }),
        } as Response)
      }
      if (url.includes('/api/partner/fairness')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(FAIRNESS_PAYLOAD) } as Response)
      }
      if (url.includes('/api/partner/monthly')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MONTHLY_PAYLOAD) } as Response)
      }
      if (url.includes('/api/partner/settlement-recommendation')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(RECOMMENDATION_PAYLOAD) } as Response)
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()

    render(
      <MemoryRouter>
        <PartnerFairnessPage />
      </MemoryRouter>,
    )

    const checkbox = await screen.findByRole('checkbox', {
      name: /exclude non-partner inflows/i,
    })
    await user.click(checkbox)

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(([url, init]) => {
        return (
          String(url).includes('/api/settings/cashflow') &&
          (init as RequestInit | undefined)?.method === 'PATCH'
        )
      })
      expect(patchCall).toBeTruthy()
    })
  })
})
