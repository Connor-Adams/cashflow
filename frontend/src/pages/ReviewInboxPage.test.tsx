import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { ReviewInboxPage } from './ReviewInboxPage'
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

function mockInbox(rows: Transaction[]) {
  vi.mocked(api.getJson).mockImplementation(async (path: string) => {
    if (path.startsWith('/api/transactions?')) {
      return { data: rows, page: 1, pageSize: 100, total: rows.length }
    }
    if (path === '/api/transactions/category-hints') return { categories: [] }
    return null
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  try {
    localStorage.clear()
  } catch {
    /* ignore */
  }
  mockInbox([])
})

function renderPage() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <ReviewInboxPage />
      </ToastProvider>
    </MemoryRouter>,
  )
}

describe('ReviewInboxPage tax treatment bulk control', () => {
  it('includes a selected tax treatment in the bulk-patch body', async () => {
    mockInbox([
      makeTransaction({
        id: 7,
        merchantClean: 'Paycheck',
        status: 'posted',
        reviewFlag: true,
        taxTreatmentOverride: null,
      }),
    ])
    vi.mocked(api.postJson).mockResolvedValue({})
    renderPage()

    const checkbox = await screen.findByLabelText(/select paycheck/i)
    await userEvent.click(checkbox)

    const taxSelect = screen.getByRole('combobox', { name: /tax treatment/i })
    await userEvent.selectOptions(taxSelect, 'employment_income')

    await userEvent.click(
      screen.getByRole('button', { name: /apply and mark reviewed/i }),
    )

    await waitFor(() => {
      expect(api.postJson).toHaveBeenCalledWith(
        '/api/transactions/bulk-patch',
        expect.objectContaining({
          ids: [7],
          patch: expect.objectContaining({
            taxTreatmentOverride: 'employment_income',
          }),
        }),
      )
    })
  })

  it('omits taxTreatmentOverride from the bulk patch when left at keep-current', async () => {
    mockInbox([
      makeTransaction({
        id: 9,
        merchantClean: 'Coffee Shop',
        status: 'posted',
        reviewFlag: true,
        taxTreatmentOverride: null,
      }),
    ])
    vi.mocked(api.postJson).mockResolvedValue({})
    renderPage()

    const checkbox = await screen.findByLabelText(/select coffee shop/i)
    await userEvent.click(checkbox)

    const businessSelect = screen.getByRole('combobox', { name: /^business$/i })
    await userEvent.selectOptions(businessSelect, 'true')

    await userEvent.click(
      screen.getByRole('button', { name: /apply and mark reviewed/i }),
    )

    await waitFor(() => {
      expect(api.postJson).toHaveBeenCalledWith(
        '/api/transactions/bulk-patch',
        expect.anything(),
      )
    })
    const [, body] = vi.mocked(api.postJson).mock.calls.find(
      ([path]) => path === '/api/transactions/bulk-patch',
    )!
    expect(body).toMatchObject({ patch: { businessOverride: true } })
    expect((body as { patch: Record<string, unknown> }).patch).not.toHaveProperty(
      'taxTreatmentOverride',
    )
  })

  it('restores the prior tax treatment when the apply is undone', async () => {
    mockInbox([
      makeTransaction({
        id: 8,
        merchantClean: 'Donation Co',
        status: 'posted',
        reviewFlag: true,
        taxTreatmentOverride: 'donations',
      }),
    ])
    vi.mocked(api.postJson).mockResolvedValue({})
    vi.mocked(api.patchJson).mockResolvedValue({})
    renderPage()

    const checkbox = await screen.findByLabelText(/select donation co/i)
    await userEvent.click(checkbox)

    const taxSelect = screen.getByRole('combobox', { name: /tax treatment/i })
    await userEvent.selectOptions(taxSelect, 'rrsp_contribution')

    await userEvent.click(
      screen.getByRole('button', { name: /apply and mark reviewed/i }),
    )

    const undo = await screen.findByRole('button', { name: /undo/i })
    await userEvent.click(undo)

    await waitFor(() => {
      expect(api.patchJson).toHaveBeenCalledWith(
        '/api/transactions/8',
        expect.objectContaining({ taxTreatmentOverride: 'donations' }),
      )
    })
  })
})

function makeTransaction(
  overrides: Partial<Transaction> &
    Pick<Transaction, 'id' | 'merchantClean' | 'status'>,
): Transaction {
  return {
    id: overrides.id,
    accountId: 1,
    householdId: 1,
    createdByUserId: 1,
    visibility: 'shared',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'May Visa',
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
    counterpartyRaw: null,
    counterpartyContactId: null,
    ...overrides,
  }
}
