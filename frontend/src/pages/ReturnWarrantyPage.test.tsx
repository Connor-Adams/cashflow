import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ReturnWarrantyPage } from './ReturnWarrantyPage'
import * as api from '@/lib/api'
import { ToastProvider } from '@/components/ui/toast'

void React

function renderPage() {
  return render(
    <ToastProvider>
      <ReturnWarrantyPage />
    </ToastProvider>,
  )
}

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getJson: vi.fn(),
    patchJson: vi.fn(),
    postJson: vi.fn(),
    postFormData: vi.fn(),
    deleteReq: vi.fn(),
  }
})

const ACTIVE_ROW = {
  id: 42,
  date: '2026-05-01',
  merchant: 'Apple Store',
  amount: '-1299.0000',
  currency: 'CAD',
  finalCategory: 'electronics',
  accountName: 'Visa Infinite',
  returnDeadline: '2026-06-15',
  warrantyEndDate: '2027-05-01',
  receiptStatus: 'have' as const,
  hasReceipt: true,
  notes: null,
  daysUntilReturnDeadline: 20,
  daysUntilWarrantyEnd: 340,
}

const MISSING_ROW = {
  id: 99,
  date: '2026-05-10',
  merchant: 'Best Buy',
  amount: '-450.0000',
  currency: 'CAD',
  finalCategory: 'electronics',
  accountName: 'Mastercard',
  returnDeadline: '2026-06-09',
  warrantyEndDate: null,
  receiptStatus: 'missing' as const,
  hasReceipt: false,
  notes: null,
  daysUntilReturnDeadline: 14,
  daysUntilWarrantyEnd: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.getJson).mockImplementation(async (path: string) => {
    if (path.startsWith('/api/return-warranty/active')) {
      return {
        data: [ACTIVE_ROW],
        count: 1,
        today: '2026-05-26',
      }
    }
    if (path.startsWith('/api/return-warranty/expiring-soon')) {
      return {
        data: [],
        count: 0,
        today: '2026-05-26',
        withinDays: 7,
        cutoff: '2026-06-02',
      }
    }
    if (path.startsWith('/api/return-warranty/warranties')) {
      return {
        data: [ACTIVE_ROW],
        count: 1,
        today: '2026-05-26',
      }
    }
    if (path.startsWith('/api/return-warranty/missing-receipts')) {
      return {
        data: [MISSING_ROW],
        count: 1,
        today: '2026-05-26',
      }
    }
    return { data: [], count: 0, today: '2026-05-26' }
  })
  vi.mocked(api.patchJson).mockResolvedValue({
    data: {
      transactionId: 42,
      returnDeadline: '2026-07-01',
      warrantyEndDate: '2027-05-01',
      notes: 'Bought online',
      receiptStatus: 'have',
      isWithinReturnWindow: true,
      isWarrantyActive: true,
      daysUntilReturnDeadline: 36,
      daysUntilWarrantyEnd: 340,
    },
  })
})

describe('ReturnWarrantyPage', () => {
  it('renders the Active returns tab and a row for the seeded txn', async () => {
    renderPage()
    expect(await screen.findByText('Apple Store')).toBeInTheDocument()
    expect(screen.getByText('2026-06-15')).toBeInTheDocument()
  })

  it('switches to Missing receipts when the tab is clicked', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('Apple Store')
    await user.click(screen.getByRole('tab', { name: /missing receipts/i }))
    expect(await screen.findByText('Best Buy')).toBeInTheDocument()
    expect(screen.getByText('Missing')).toBeInTheDocument()
  })

  it('opens the edit dialog and PATCHes when Save is clicked', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('Apple Store')
    await user.click(screen.getByRole('button', { name: /edit/i }))
    const dialog = await screen.findByRole('dialog')
    const deadlineInput = within(dialog).getByLabelText(/return deadline/i)
    await user.clear(deadlineInput)
    await user.type(deadlineInput, '2026-07-01')
    await user.click(within(dialog).getByRole('button', { name: /save/i }))
    await waitFor(() => {
      expect(api.patchJson).toHaveBeenCalledWith(
        '/api/transactions/42/return-warranty',
        expect.objectContaining({ returnDeadline: '2026-07-01' }),
      )
    })
  })

  it('passes ?days when switching to Expiring soon and changing the window', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('Apple Store')
    await user.click(screen.getByRole('tab', { name: /expiring soon/i }))
    await waitFor(() => {
      expect(api.getJson).toHaveBeenCalledWith(
        expect.stringContaining('/api/return-warranty/expiring-soon?days=7'),
      )
    })
    await user.selectOptions(screen.getByLabelText(/window/i), '14')
    await waitFor(() => {
      expect(api.getJson).toHaveBeenCalledWith(
        expect.stringContaining('/api/return-warranty/expiring-soon?days=14'),
      )
    })
  })
})
