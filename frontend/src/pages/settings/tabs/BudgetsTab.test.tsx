import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { ToastProvider } from '@/components/ui/toast'
import { BudgetsTab } from './BudgetsTab'

vi.stubGlobal('fetch', vi.fn(() =>
  Promise.resolve({ ok: true, json: () => Promise.resolve([]) } as Response),
))

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
})
