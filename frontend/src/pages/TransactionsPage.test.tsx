import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { TransactionsPage } from './TransactionsPage'
import { ToastProvider } from '@/components/ui/toast'
import * as api from '@/lib/api'

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
