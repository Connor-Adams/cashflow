import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
import { ToastProvider } from '@/components/ui/toast'
import { BudgetsTab } from './BudgetsTab'

vi.stubGlobal(
  'fetch',
  vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    // /api/budgets returns { data: [...] }; /api/transactions/category-hints
    // returns { categories: [...] }. Pre-existing fixture returned `[]` which
    // crashes the new BudgetsTab.useMemo sort because sortedBudgets reads
    // resp.data and tries to spread undefined.
    if (url.includes('/api/budgets')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) } as Response)
    }
    if (url.includes('/category-hints')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ categories: [] }) } as Response)
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve([]) } as Response)
  }),
)

describe('BudgetsTab', () => {
  it('renders the Budgets heading', () => {
    render(
      <ToastProvider>
        <BudgetsTab />
      </ToastProvider>
    )
    // Heading text is just "Budgets" — the page now supports scope and
    // period beyond monthly.
    expect(screen.getByRole('heading', { name: /^budgets$/i })).toBeInTheDocument()
  })

  it('exposes scope and period selectors in the create form', () => {
    render(
      <ToastProvider>
        <BudgetsTab />
      </ToastProvider>
    )
    expect(screen.getByLabelText(/^scope$/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/^period$/i)).toBeInTheDocument()
  })

  it('exposes alert threshold chips with the spec defaults selected (issue #268)', () => {
    render(
      <ToastProvider>
        <BudgetsTab />
      </ToastProvider>,
    )
    // The "Alert me at" legend exposes the chip group.
    expect(screen.getByText(/alert me at/i)).toBeInTheDocument()
    // 80 / 100 / 120 chips appear with checkbox semantics, all checked by
    // default to match the spec ([80, 100, 120]).
    for (const t of [80, 100, 120]) {
      const cb = screen.getByRole('checkbox', { name: new RegExp(`alert at ${t}%`, 'i') })
      expect(cb).toBeChecked()
    }
  })

  it('renders skeletons while loading', () => {
    // getJson (used to load budgets) ultimately calls fetch. Re-stub fetch with
    // a never-resolving promise so the load never completes and loading stays
    // true, then restore the route-aware stub for sibling tests.
    const original = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    try {
      const { container } = render(
        <ToastProvider>
          <BudgetsTab />
        </ToastProvider>,
      )
      expect(
        container.querySelectorAll('[data-slot="skeleton"]').length,
      ).toBeGreaterThan(0)
    } finally {
      vi.stubGlobal('fetch', original)
    }
  })

  it('toggling an alert chip flips its checkbox state', async () => {
    const user = userEvent.setup()
    render(
      <ToastProvider>
        <BudgetsTab />
      </ToastProvider>,
    )
    const ninety = screen.getByRole('checkbox', { name: /alert at 100%/i })
    expect(ninety).toBeChecked()
    await user.click(ninety)
    await waitFor(() => expect(ninety).not.toBeChecked())
  })
})
