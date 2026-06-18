import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { ToastProvider } from '@/components/ui/toast'
import { ImportBatchPage, type BatchDetailRow } from './ImportBatchPage'

// Mock the api module. getJson is routed by URL so the detail card, the
// stage-count badges, the confidence badges, and the AICleanupPanel fetch all
// resolve. Same idiom as SavingsRatePage.test.tsx / AccountsPage.test.tsx.
const detailRow: BatchDetailRow = {
  id: 123,
  fileName: 'amex-2026-05.csv',
  batchLabel: 'amex-may',
  status: 'done',
  rowCount: 42,
  errorMessage: null,
  startedAt: '2026-05-31T10:15:30',
  finishedAt: '2026-05-31T10:15:45',
  cleanCount: 30,
  needsReviewCount: 7,
  unknownCount: 5,
  accountId: 9,
  profileId: 'amex-profile',
  insertedCount: 40,
  skippedDuplicateCount: 2,
  rowErrorsCount: 1,
  rolledBackAt: null,
  rolledBackByUserId: null,
  account: {
    id: 9,
    name: 'Amex Gold',
    shortCode: 'AMEX',
    accountType: 'credit',
  },
}

const getJsonMock = vi.fn((url: string) => {
  if (url.startsWith('/api/import/batches/')) {
    return Promise.resolve(detailRow)
  }
  if (url.startsWith('/api/import/history')) {
    return Promise.resolve([])
  }
  if (url.startsWith('/api/ai/import-cleanup')) {
    // AICleanupPanel fetch — minimal shape, content is not asserted here.
    return Promise.resolve({ items: [], summary: null })
  }
  return Promise.resolve(null)
})

vi.mock('../lib/api', () => ({
  getJson: (url: string) => getJsonMock(url),
  postJson: vi.fn(() => Promise.resolve({})),
  patchJson: vi.fn(() => Promise.resolve({})),
  deleteReq: vi.fn(() => Promise.resolve(undefined)),
}))

function renderPage(batchId = '123') {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[`/import/${batchId}`]}>
        <Routes>
          <Route path="/import/:batchId" element={<ImportBatchPage />} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  )
}

describe('ImportBatchPage', () => {
  it('renders the batch detail header with the batch label', async () => {
    renderPage()
    expect(
      await screen.findByRole('heading', { name: /import amex-may/i, level: 1 }),
    ).toBeInTheDocument()
  })

  it('renders the batch summary section heading', async () => {
    renderPage()
    expect(
      await screen.findByRole('heading', { name: /batch summary/i }),
    ).toBeInTheDocument()
  })

  it('renders the per-stage import count chips', async () => {
    renderPage()
    expect(await screen.findByText(/40 imported/i)).toBeInTheDocument()
    expect(screen.getByText(/2 duplicates skipped/i)).toBeInTheDocument()
    expect(screen.getByText(/1 row error/i)).toBeInTheDocument()
  })

  it('renders the confidence breakdown chips including the needs-review link', async () => {
    renderPage()
    expect(await screen.findByText(/30 clean/i)).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: /7 need review/i }),
    ).toBeInTheDocument()
    expect(screen.getByText(/5 legacy/i)).toBeInTheDocument()
  })

  it('renders the view-transactions link', async () => {
    renderPage()
    expect(
      await screen.findByRole('link', { name: /view transactions/i }),
    ).toBeInTheDocument()
  })

  it('renders a not-found empty state when no batch matches', async () => {
    getJsonMock.mockImplementationOnce(() => Promise.reject(new Error('not found')))
    renderPage('999')
    expect(await screen.findByText(/batch not found/i)).toBeInTheDocument()
  })
})
