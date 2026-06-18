import React from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ToastProvider } from '@/components/ui/toast'
import { ReimbursementsPage } from './ReimbursementsPage'
import type {
  ReimbursementView,
  ReimbursementListResponse,
  ReimbursementSummaryResponse,
} from '../types/reimbursement'

// One realistic outstanding row so the table body renders a data row.
const ROW: ReimbursementView = {
  id: 1,
  householdId: 1,
  transactionId: 100,
  contactId: 5,
  partyName: 'Acme Insurer',
  partyLabel: 'Acme Insurer',
  amount: '125.00',
  currency: 'CAD',
  dueDate: '2026-06-25',
  status: 'expected',
  effectiveStatus: 'expected',
  isOverdue: false,
  daysUntilDue: 7,
  repaymentTransactionId: null,
  receivedAt: null,
  notes: null,
  createdAt: '2026-06-01',
  updatedAt: '2026-06-01',
  contact: { id: 5, name: 'Acme Insurer' },
  transaction: {
    id: 100,
    date: '2026-06-01',
    merchant: 'Clinic',
    amount: '125.00',
    currency: 'CAD',
  },
  repaymentTransaction: null,
}

const SUMMARY_EMPTY: ReimbursementSummaryResponse = {
  groups: [],
  outstandingByCurrency: {},
  overdueCount: 0,
  totalCount: 0,
  today: '2026-06-18',
}

// Toggle whether the list endpoints return ROW or are empty.
let listEmpty = false

vi.mock('../lib/api', () => ({
  getJson: vi.fn((url: string) => {
    if (url.includes('/api/reimbursements/summary')) {
      return Promise.resolve(SUMMARY_EMPTY)
    }
    if (url.includes('/api/reimbursements/overdue')) {
      return Promise.resolve({
        data: listEmpty ? [] : [ROW],
        count: listEmpty ? 0 : 1,
        today: '2026-06-18',
      } satisfies ReimbursementListResponse)
    }
    if (url.includes('/match-candidates')) {
      return Promise.resolve({ data: [], count: 0 })
    }
    if (url.includes('/api/contacts')) {
      return Promise.resolve([])
    }
    if (url.includes('/api/reimbursements')) {
      return Promise.resolve({
        data: listEmpty ? [] : [ROW],
        count: listEmpty ? 0 : 1,
        today: '2026-06-18',
      } satisfies ReimbursementListResponse)
    }
    return Promise.resolve({})
  }),
  postJson: vi.fn(() => Promise.resolve({})),
  patchJson: vi.fn(() => Promise.resolve({})),
  deleteReq: vi.fn(() => Promise.resolve(undefined)),
}))

function renderPage() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <ReimbursementsPage />
      </ToastProvider>
    </MemoryRouter>,
  )
}

describe('ReimbursementsPage', () => {
  beforeEach(() => {
    listEmpty = false
  })

  it('renders the page heading', async () => {
    renderPage()
    expect(
      await screen.findByRole('heading', { name: /reimbursements/i, level: 1 }),
    ).toBeInTheDocument()
  })

  it('renders the table column headers', async () => {
    renderPage()
    expect(await screen.findByRole('columnheader', { name: /^party$/i })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: /^amount$/i })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: /^status$/i })).toBeInTheDocument()
  })

  it('renders the tab labels', async () => {
    renderPage()
    expect(await screen.findByRole('tab', { name: /outstanding/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /overdue/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /received/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /^all$/i })).toBeInTheDocument()
  })

  it('renders a data row when the list is non-empty', async () => {
    renderPage()
    expect(await screen.findByText('Acme Insurer')).toBeInTheDocument()
  })

  it('renders the empty-state row when all lists are empty', async () => {
    listEmpty = true
    renderPage()
    expect(
      await screen.findByText(/nothing outstanding/i),
    ).toBeInTheDocument()
  })
})
