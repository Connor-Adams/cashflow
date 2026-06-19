import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { ImportPage } from './ImportPage'
import * as api from '@/lib/api'

void React

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, getJson: vi.fn() }
})

// The real ImportModal pulls in the full upload UI; stub it to a marker that
// reflects its open state so we can assert the CTA opens it.
vi.mock('../components/import/ImportModal', () => ({
  ImportModal: ({ open }: { open: boolean }) => (
    <div data-testid="import-modal" data-open={String(open)} />
  ),
}))

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.getJson).mockImplementation(async (path: string) => {
    if (path === '/api/accounts') return []
    if (path === '/api/import/history') return []
    return null
  })
})

afterEach(() => cleanup())

function renderPage() {
  return render(
    <MemoryRouter>
      <ImportPage />
    </MemoryRouter>,
  )
}

describe('ImportPage empty state (#799)', () => {
  it('shows the "No imports yet" EmptyState when the history is empty', async () => {
    renderPage()
    expect(await screen.findByText('No imports yet')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /import a statement/i })).toBeInTheDocument()
  })

  it('opens the import modal when the empty-state CTA is clicked', async () => {
    renderPage()
    await screen.findByText('No imports yet')
    expect(screen.getByTestId('import-modal')).toHaveAttribute('data-open', 'false')
    await userEvent.click(screen.getByRole('button', { name: /import a statement/i }))
    expect(screen.getByTestId('import-modal')).toHaveAttribute('data-open', 'true')
  })

  it('does not show the empty state when the history has rows', async () => {
    vi.mocked(api.getJson).mockImplementation(async (path: string) => {
      if (path === '/api/accounts') return []
      if (path === '/api/import/history') {
        return [
          {
            id: 1,
            fileName: 'rbc.csv',
            batchLabel: 'rbc-2026-01',
            status: 'done',
            rowCount: 42,
            errorMessage: null,
            startedAt: '2026-01-02T10:00:00.000Z',
            finishedAt: '2026-01-02T10:00:05.000Z',
          },
        ]
      }
      return null
    })
    renderPage()
    await waitFor(() => expect(screen.getByText('rbc-2026-01')).toBeInTheDocument())
    expect(screen.queryByText('No imports yet')).not.toBeInTheDocument()
  })
})
