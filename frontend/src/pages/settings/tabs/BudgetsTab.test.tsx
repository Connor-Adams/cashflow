import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { ToastProvider } from '@/components/ui/toast'
import { BudgetsTab } from './BudgetsTab'

vi.stubGlobal('fetch', vi.fn(() =>
  Promise.resolve({ ok: true, json: () => Promise.resolve([]) } as Response),
))

describe('BudgetsTab', () => {
  it('renders the Monthly budgets heading', () => {
    render(
      <ToastProvider>
        <BudgetsTab />
      </ToastProvider>
    )
    expect(screen.getByRole('heading', { name: /monthly budgets/i })).toBeInTheDocument()
  })
})
