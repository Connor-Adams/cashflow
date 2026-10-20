import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ToastProvider } from '@/components/ui/toast'
import { MonthlyClosePage } from './MonthlyClosePage'

// "Monthly close" is a review checklist, NOT a lock: nothing server-side
// blocks imports or edits into a closed month. These tests pin the copy so
// the page never again promises a lock it doesn't enforce.

type Status = 'open' | 'closed'

const state: { status: Status; hasCritical: boolean } = {
  status: 'open',
  hasCritical: false,
}

function period(status: Status) {
  return {
    id: 1,
    householdId: 1,
    userId: 1,
    periodMonth: '2026-09',
    status,
    openedAt: '2026-10-01T00:00:00.000Z',
    closedAt: status === 'closed' ? '2026-10-02T00:00:00.000Z' : null,
    notes: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  }
}

vi.mock('../lib/api', () => ({
  getJson: vi.fn((url: string) => {
    if (url === '/api/monthly-close') {
      return Promise.resolve({ data: [period(state.status)] })
    }
    return Promise.resolve({
      period: period(state.status),
      tasks: [
        {
          id: 10,
          periodId: 1,
          taskKey: 'imports',
          isComplete: true,
          completedAt: null,
          completedByUserId: null,
          notes: null,
          sortOrder: 0,
          createdAt: '2026-10-01T00:00:00.000Z',
          updatedAt: '2026-10-01T00:00:00.000Z',
        },
      ],
      critical: {
        counts: {
          unreviewedTransactions: state.hasCritical ? 2 : 0,
          outstandingPartnerBuckets: 0,
        },
        reasons: state.hasCritical ? ['unreviewed_transactions'] : [],
        hasCritical: state.hasCritical,
      },
    })
  }),
  patchJson: vi.fn(),
  postJson: vi.fn(),
}))

function renderPage() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <MonthlyClosePage />
      </ToastProvider>
    </MemoryRouter>,
  )
}

function expectNoLockLanguage(container: HTMLElement) {
  expect(container.querySelector('[data-icon="lock"]')).toBeNull()
  expect(container.querySelector('[data-icon="unlock"]')).toBeNull()
  expect(screen.queryByRole('button', { name: /close month/i })).toBeNull()
  expect(screen.queryByRole('button', { name: /force/i })).toBeNull()
  expect(container.textContent ?? '').not.toMatch(/\b(lock|locked|freeze|frozen)\b/i)
}

describe('MonthlyClosePage (review checklist, not a lock)', () => {
  beforeEach(() => {
    state.status = 'open'
    state.hasCritical = false
  })

  it('offers "Mark month reviewed" on an in-progress month', async () => {
    const { container } = renderPage()
    expect(
      await screen.findByRole('button', { name: 'Mark month reviewed' }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /with warnings/i })).toBeNull()
    expectNoLockLanguage(container)
  })

  it('offers "Mark reviewed with warnings" when critical items remain', async () => {
    state.hasCritical = true
    const { container } = renderPage()
    expect(
      await screen.findByRole('button', { name: 'Mark reviewed with warnings' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Mark month reviewed' })).toBeInTheDocument()
    expectNoLockLanguage(container)
  })

  it('shows a reviewed month with "Reopen review" and no lock wording', async () => {
    state.status = 'closed'
    const { container } = renderPage()
    expect(
      await screen.findByRole('button', { name: 'Reopen review' }),
    ).toBeInTheDocument()
    expect(screen.getAllByText('Reviewed').length).toBeGreaterThan(0)
    expect(screen.queryByText(/^closed$/i)).toBeNull()
    expectNoLockLanguage(container)
  })
})
