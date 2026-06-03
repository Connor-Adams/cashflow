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

describe('ReviewInboxPage itemized badge', () => {
  it('shows item count and straggler count badge when row.itemized is set', async () => {
    mockInbox([
      makeTransaction({
        id: 42,
        merchantClean: 'Amazon',
        status: 'posted',
        reviewFlag: true,
        itemized: { itemCount: 12, stragglerCount: 3 },
      }),
    ])
    renderPage()
    expect(await screen.findByText(/12 items/)).toBeInTheDocument()
    expect(screen.getByText(/3 need review/)).toBeInTheDocument()
  })

  it('shows no itemized badge when row.itemized is null', async () => {
    mockInbox([
      makeTransaction({
        id: 43,
        merchantClean: 'Coffee Shop',
        status: 'posted',
        reviewFlag: true,
        itemized: null,
      }),
    ])
    renderPage()
    await screen.findByText('Coffee Shop')
    expect(screen.queryByText(/items/)).not.toBeInTheDocument()
  })

  it('clicking the badge loads items and renders an item row', async () => {
    mockInbox([
      makeTransaction({
        id: 44,
        merchantClean: 'Costco',
        status: 'posted',
        reviewFlag: true,
        itemized: { itemCount: 2, stragglerCount: 1 },
      }),
    ])
    vi.mocked(api.getJson).mockImplementation(async (path: string) => {
      if (path.startsWith('/api/transactions?')) {
        return {
          data: [
            makeTransaction({
              id: 44,
              merchantClean: 'Costco',
              status: 'posted',
              reviewFlag: true,
              itemized: { itemCount: 2, stragglerCount: 1 },
            }),
          ],
          page: 1,
          pageSize: 100,
          total: 1,
        }
      }
      if (path === '/api/transactions/category-hints') return { categories: [] }
      if (path === '/api/transactions/44/receipts') {
        return [
          {
            id: 1,
            transactionId: 44,
            originalName: 'receipt.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 1000,
            extractedNote: null,
            createdAt: '2026-01-01T00:00:00Z',
            externalOrderId: 10,
            order: {
              id: 10,
              vendor: 'costco',
              subtotal: '20.00',
              tax: '2.60',
              shipping: null,
              total: '22.60',
              currency: 'CAD',
            },
            items: [
              {
                id: 201,
                externalOrderId: 10,
                title: 'Olive Oil',
                quantity: 1,
                unitPrice: '12.00',
                totalPrice: '12.00',
                inferredCategory: null,
                categoryOverride: null,
                businessUsePercent: null,
                businessUseOverride: null,
              },
              {
                id: 202,
                externalOrderId: 10,
                title: 'Paper Towels',
                quantity: 2,
                unitPrice: '4.00',
                totalPrice: '8.00',
                inferredCategory: 'Household',
                categoryOverride: null,
                businessUsePercent: null,
                businessUseOverride: null,
              },
            ],
          },
        ]
      }
      return null
    })

    renderPage()

    // Click the badge to expand
    const badge = await screen.findByRole('button', { name: /2 items/i })
    await userEvent.click(badge)

    // Should call the receipts endpoint
    await waitFor(() => {
      expect(api.getJson).toHaveBeenCalledWith('/api/transactions/44/receipts')
    })

    // Should render item titles
    expect(await screen.findByText('Olive Oil')).toBeInTheDocument()
    expect(screen.getByText('Paper Towels')).toBeInTheDocument()
  })

  it('item with inferredCategory but confidence < 80 is treated as a straggler (sorted to top)', async () => {
    // Two items: one has inferredCategory+high confidence (resolved), one has
    // inferredCategory+low confidence (straggler). The straggler must appear first
    // in the rendered list because isItemStraggler gates on confidence >= 80.
    mockInbox([
      makeTransaction({
        id: 55,
        merchantClean: 'Costco',
        status: 'posted',
        reviewFlag: true,
        itemized: { itemCount: 2, stragglerCount: 1 },
      }),
    ])
    vi.mocked(api.getJson).mockImplementation(async (path: string) => {
      if (path.startsWith('/api/transactions?')) {
        return {
          data: [
            makeTransaction({
              id: 55,
              merchantClean: 'Costco',
              status: 'posted',
              reviewFlag: true,
              itemized: { itemCount: 2, stragglerCount: 1 },
            }),
          ],
          page: 1,
          pageSize: 100,
          total: 1,
        }
      }
      if (path === '/api/transactions/category-hints') return { categories: [] }
      if (path === '/api/transactions/55/receipts') {
        return [
          {
            id: 5,
            transactionId: 55,
            originalName: 'receipt.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 500,
            extractedNote: null,
            createdAt: '2026-01-01T00:00:00Z',
            externalOrderId: 20,
            order: {
              id: 20,
              vendor: 'costco',
              subtotal: '30.00',
              tax: null,
              shipping: null,
              total: '30.00',
              currency: 'CAD',
            },
            items: [
              {
                // Resolved: high-confidence → NOT a straggler → sorted after
                id: 301,
                externalOrderId: 20,
                title: 'High Confidence Item',
                quantity: 1,
                unitPrice: '20.00',
                totalPrice: '20.00',
                inferredCategory: 'Groceries',
                categoryOverride: null,
                businessUsePercent: null,
                businessUseOverride: null,
                confidence: '90',
              },
              {
                // Straggler: inferredCategory set but confidence too low (30) → straggler → sorted first
                id: 302,
                externalOrderId: 20,
                title: 'Low Confidence Item',
                quantity: 1,
                unitPrice: '10.00',
                totalPrice: '10.00',
                inferredCategory: 'Electronics',
                categoryOverride: null,
                businessUsePercent: null,
                businessUseOverride: null,
                confidence: '30',
              },
            ],
          },
        ]
      }
      return null
    })

    renderPage()

    const badge = await screen.findByRole('button', { name: /2 items/i })
    await userEvent.click(badge)

    await waitFor(() => {
      expect(api.getJson).toHaveBeenCalledWith('/api/transactions/55/receipts')
    })

    // Both items must be visible.
    const highItem = await screen.findByText('High Confidence Item')
    const lowItem = screen.getByText('Low Confidence Item')
    expect(highItem).toBeInTheDocument()
    expect(lowItem).toBeInTheDocument()

    // The low-confidence item (straggler) must appear before the high-confidence item in the DOM.
    // Use compareDocumentPosition: DOCUMENT_POSITION_FOLLOWING (4) means lowItem precedes highItem.
    const position = lowItem.compareDocumentPosition(highItem)
    // eslint-disable-next-line no-bitwise
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
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
