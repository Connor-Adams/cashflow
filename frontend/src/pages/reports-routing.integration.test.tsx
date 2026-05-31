import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { ReportsLayout } from './ReportsLayout'
import { ExplainMonthPage } from './ExplainMonthPage'
import { ReportsPage } from './ReportsPage'
import * as api from '@/lib/api'
import { ToastProvider } from '@/components/ui/toast'

void React

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, getJson: vi.fn(), postJson: vi.fn(), deleteReq: vi.fn() }
})

// Superset of every shape the mounted pages read, so neither ReportsPage nor
// ExplainMonthPage throws on the empty-data path.
const EMPTY = {
  byCurrency: [],
  data: [],
  findings: [],
  merchantSummaries: [],
  accountSummaries: [],
}

beforeEach(() => {
  vi.mocked(api.getJson).mockResolvedValue(EMPTY as never)
})

function renderAt(path: string) {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/reports" element={<ReportsLayout />}>
            <Route index element={<ReportsPage />} />
            <Route path="explain-month" element={<ExplainMonthPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  )
}

describe('reports routing (PR 0)', () => {
  it('/reports renders the Reports summary under the tab bar', async () => {
    renderAt('/reports')
    expect(screen.getByRole('tab', { name: 'Summary' })).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Reports' })).toBeInTheDocument(),
    )
  })

  it('/reports/explain-month mounts under the same tab bar with Explain month active', () => {
    renderAt('/reports/explain-month')
    expect(screen.getByRole('tab', { name: 'Explain month' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
  })
})
