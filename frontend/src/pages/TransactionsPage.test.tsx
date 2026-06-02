import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { TransactionsPage } from './TransactionsPage'
import { ToastProvider } from '@/components/ui/toast'
import * as api from '@/lib/api'
import type { Transaction } from '@/types/api'

void React

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getJson: vi.fn(),
    patchJson: vi.fn(),
    postJson: vi.fn(),
    deleteReq: vi.fn(),
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  sessionStorage.clear()
  vi.mocked(api.getJson).mockImplementation(async (path: string) => {
    if (path.startsWith('/api/transactions?')) {
      return { data: [], page: 1, pageSize: 25, total: 0 }
    }
    if (path === '/api/transactions/category-hints') return { categories: [] }
    if (path === '/api/ai/status') return { openai: false }
    if (path === '/api/contacts') return []
    return null
  })
})

function renderPage() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <TransactionsPage />
      </ToastProvider>
    </MemoryRouter>,
  )
}

describe('TransactionsPage date range validation', () => {
  it('shows inline error when dateFrom > dateTo', async () => {
    renderPage()
    const fromInput = await screen.findByLabelText(/^from$/i)
    const toInput = await screen.findByLabelText(/^to$/i)
    await userEvent.type(fromInput, '2026-05-10')
    await userEvent.type(toInput, '2026-05-01')
    await waitFor(() =>
      expect(
        screen.getByText(/end date must be on or after start date/i),
      ).toBeInTheDocument(),
    )
  })

  it('allows dateFrom === dateTo (one-day filter)', async () => {
    renderPage()
    const fromInput = await screen.findByLabelText(/^from$/i)
    const toInput = await screen.findByLabelText(/^to$/i)
    await userEvent.type(fromInput, '2026-05-10')
    await userEvent.type(toInput, '2026-05-10')
    expect(
      screen.queryByText(/end date must be on or after start date/i),
    ).not.toBeInTheDocument()
  })

  it('does not fire a transactions list request with an invalid range', async () => {
    renderPage()
    // Initial mount triggers one /api/transactions GET.
    await waitFor(() =>
      expect(
        vi
          .mocked(api.getJson)
          .mock.calls.filter((c) =>
            String(c[0]).startsWith('/api/transactions?'),
          ).length,
      ).toBeGreaterThanOrEqual(1),
    )
    const initialCount = vi
      .mocked(api.getJson)
      .mock.calls.filter((c) => String(c[0]).startsWith('/api/transactions?'))
      .length
    const fromInput = await screen.findByLabelText(/^from$/i)
    const toInput = await screen.findByLabelText(/^to$/i)
    await userEvent.type(fromInput, '2026-05-10')
    await userEvent.type(toInput, '2026-05-01')
    // wait for the error to be present
    await screen.findByText(/end date must be on or after start date/i)
    // Now any subsequent /api/transactions GETs (since the bad range was
    // entered) should not include the dateFrom or dateTo query params.
    const afterCalls = vi
      .mocked(api.getJson)
      .mock.calls.filter((c) => String(c[0]).startsWith('/api/transactions?'))
      .slice(initialCount)
    // Confirm no API call was issued with the invalid (dateFrom > dateTo) pair.
    for (const call of afterCalls) {
      const url = String(call[0])
      const u = new URL(url, 'http://localhost')
      const from = u.searchParams.get('dateFrom')
      const to = u.searchParams.get('dateTo')
      if (from && to) {
        expect(from <= to).toBe(true)
      }
    }
  })
})

describe('TransactionsPage transaction status controls', () => {
  it('sends status query param from the status filter chips', async () => {
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: /^pending$/i }))
    await waitFor(() =>
      expect(
        vi
          .mocked(api.getJson)
          .mock.calls.some((call) => String(call[0]).includes('status=pending')),
      ).toBe(true),
    )
  })

  it('renders Pending and Cleared badges but no Posted badge', async () => {
    vi.mocked(api.getJson).mockImplementation(async (path: string) => {
      if (path.startsWith('/api/transactions?')) {
        return {
          data: [
            makeTransaction({ id: 1, merchantClean: 'Pending Merchant', status: 'pending' }),
            makeTransaction({ id: 2, merchantClean: 'Cleared Merchant', status: 'cleared' }),
            makeTransaction({ id: 3, merchantClean: 'Posted Merchant', status: 'posted' }),
          ],
          page: 1,
          pageSize: 25,
          total: 3,
        }
      }
      if (path === '/api/transactions/category-hints') return { categories: [] }
      if (path === '/api/ai/status') return { openai: false }
      if (path === '/api/contacts') return []
      return null
    })
    renderPage()
    expect(await screen.findByText('Pending')).toBeInTheDocument()
    expect(screen.getAllByText('Cleared').length).toBeGreaterThan(0)
    expect(screen.queryByTitle('Posted')).not.toBeInTheDocument()
  })

  it('confirms before changing a transaction to cleared', async () => {
    vi.mocked(api.getJson).mockImplementation(async (path: string) => {
      if (path.startsWith('/api/transactions?')) {
        return {
          data: [makeTransaction({ id: 11, merchantClean: 'Clear Me', status: 'posted' })],
          page: 1,
          pageSize: 25,
          total: 1,
        }
      }
      if (path === '/api/transactions/category-hints') return { categories: [] }
      if (path === '/api/ai/status') return { openai: false }
      if (path === '/api/contacts') return []
      return null
    })
    renderPage()
    const statusSelect = await screen.findByLabelText(/status for clear me/i)
    await userEvent.selectOptions(statusSelect, 'cleared')
    expect(await screen.findByText('Mark as cleared?')).toBeInTheDocument()
    expect(
      screen.getByText('Cleared usually comes from statement reconciliation. Continue?'),
    ).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Mark cleared' }))
    await waitFor(() =>
      expect(api.patchJson).toHaveBeenCalledWith('/api/transactions/11', {
        status: 'cleared',
      }),
    )
  })
})

describe('TransactionsPage tax treatment override control', () => {
  it('changing tax treatment override includes it in the PATCH call', async () => {
    vi.mocked(api.getJson).mockImplementation(async (path: string) => {
      if (path.startsWith('/api/transactions?')) {
        return {
          data: [
            makeTransaction({
              id: 42,
              merchantClean: 'Tax Test Merchant',
              status: 'posted',
              taxTreatmentOverride: null,
            }),
          ],
          page: 1,
          pageSize: 25,
          total: 1,
        }
      }
      if (path === '/api/transactions/category-hints') return { categories: [] }
      if (path === '/api/ai/status') return { openai: false }
      if (path === '/api/contacts') return []
      return null
    })
    vi.mocked(api.patchJson).mockResolvedValue({})
    renderPage()

    const select = await screen.findByRole('combobox', {
      name: /tax treatment override for transaction 42/i,
    })
    await userEvent.selectOptions(select, 'rrsp_contribution')

    const saveButton = screen.getByRole('button', { name: /^save$/i })
    await userEvent.click(saveButton)

    await waitFor(() => {
      expect(api.patchJson).toHaveBeenCalledWith(
        '/api/transactions/42',
        expect.objectContaining({ taxTreatmentOverride: 'rrsp_contribution' }),
      )
    })
  })
})

function makeTransaction(
  overrides: Partial<Transaction> & Pick<Transaction, 'id' | 'merchantClean' | 'status'>,
): Transaction {
  return {
    id: overrides.id,
    accountId: 1,
    householdId: 1,
    createdByUserId: 1,
    visibility: 'shared',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'test',
    date: '2026-05-01',
    merchantRaw: overrides.merchantClean,
    merchantClean: overrides.merchantClean,
    amount: -10,
    currency: 'CAD',
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: `row-${overrides.id}`,
    appliedRuleId: null,
    autoCategory: null,
    categoryOverride: null,
    finalCategory: null,
    autoBusiness: null,
    businessOverride: null,
    finalBusiness: false,
    taxTreatmentOverride: null,
    autoSplitType: null,
    splitOverride: null,
    finalSplitType: 'me',
    autoPctMe: null,
    pctMeOverride: null,
    finalPctMe: null,
    autoPctPartner: null,
    pctPartnerOverride: null,
    finalPctPartner: null,
    myShareAmount: -10,
    partnerShareAmount: 0,
    businessAmount: 0,
    reviewFlag: false,
    reviewedAt: null,
    merchantCanonical: null,
    txnType: 'purchase',
    autoSource: null,
    autoConfidence: null,
    linkedTransactionId: null,
    transferPurpose: null,
    transferLinkedAt: null,
    isRecurring: false,
    status: overrides.status,
    ...overrides,
  }
}
