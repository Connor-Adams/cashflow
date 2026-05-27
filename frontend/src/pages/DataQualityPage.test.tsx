/**
 * DataQualityPage smoke tests (#234). Mocks /api/data-quality so we can
 * verify the page renders the overall score, the seven cards, and the
 * action-link wiring without spinning up a backend.
 */
import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DataQualityPage } from './DataQualityPage'

type Response = {
  score: number
  componentScores: Record<string, number>
  components: Record<string, unknown>
  totals: { transactionsScanned: number; spendTransactions: number }
  actionLinks: Array<{ key: string; label: string; href: string; description: string }>
}

const FULL_RESPONSE: Response = {
  score: 0.75,
  componentScores: {
    categorization: 0.8,
    rules: 0.6,
    receipts: 0.5,
    duplicates: 0.9,
    transfers: 1,
    subscriptions: 1,
    review: 0.5,
  },
  components: {
    categorization: { totalSpend: 100, categorized: 80, uncategorized: 20, coverage: 0.8 },
    rules: { totalSpend: 100, ruleCovered: 60, uncovered: 40, coverage: 0.6 },
    receipts: { totalSpend: 100, withReceipt: 50, missing: 50, coverage: 0.5 },
    duplicates: { duplicateGroups: 2, duplicateTransactions: 4 },
    transfers: { unmatched: 0 },
    subscriptions: { stale: 0 },
    review: { backlog: 25 },
  },
  totals: { transactionsScanned: 120, spendTransactions: 100 },
  actionLinks: [
    { key: 'categorization', label: 'Categorized', href: '/transactions?finalCategory=__none__', description: 'cat desc' },
    { key: 'rules', label: 'Rule coverage', href: '/rules', description: 'rules desc' },
    { key: 'receipts', label: 'Receipts', href: '/transactions?missingReceipt=1', description: 'receipts desc' },
    { key: 'duplicates', label: 'Duplicates', href: '/transactions?duplicates=1', description: 'dupes desc' },
    { key: 'transfers', label: 'Unmatched transfers', href: '/transactions?txnType=transfer&unmatched=1', description: 'transfers desc' },
    { key: 'subscriptions', label: 'Stale subscriptions', href: '/subscriptions?status=unknown', description: 'subs desc' },
    { key: 'review', label: 'Review backlog', href: '/review', description: 'review desc' },
  ],
}

function mockFetch(body: Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo) => {
      const url = String(input)
      if (url.endsWith('/api/data-quality')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response & {
          ok: boolean
          json: () => Promise<Response>
        })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response & {
        ok: boolean
        json: () => Promise<unknown>
      })
    }),
  )
}

describe('DataQualityPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('renders the overall score and each component card with its label', async () => {
    mockFetch(FULL_RESPONSE)
    render(
      <MemoryRouter initialEntries={['/data-quality']}>
        <DataQualityPage />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('75%')).toBeInTheDocument())
    // Each of the seven component card labels appears.
    expect(screen.getByText('Categorized')).toBeInTheDocument()
    expect(screen.getByText('Rule coverage')).toBeInTheDocument()
    expect(screen.getByText('Receipts')).toBeInTheDocument()
    expect(screen.getByText('Duplicates')).toBeInTheDocument()
    expect(screen.getByText('Unmatched transfers')).toBeInTheDocument()
    expect(screen.getByText('Stale subscriptions')).toBeInTheDocument()
    expect(screen.getByText('Review backlog')).toBeInTheDocument()
  })

  it('renders click-through links pointing at the action-link hrefs', async () => {
    mockFetch(FULL_RESPONSE)
    render(
      <MemoryRouter initialEntries={['/data-quality']}>
        <DataQualityPage />
      </MemoryRouter>,
    )
    // Wait for the page to settle before querying for the categorization
    // anchor — otherwise we race the fetch resolution.
    await waitFor(() =>
      expect(screen.getByLabelText(/Categorized: 80 of 100/)).toBeInTheDocument(),
    )
    const categorizationLink = screen.getByLabelText(/Categorized: 80 of 100/) as HTMLAnchorElement
    expect(categorizationLink.tagName).toBe('A')
    expect(categorizationLink.getAttribute('href')).toBe('/transactions?finalCategory=__none__')

    const reviewLink = screen.getByLabelText(/Review backlog: 25 flagged for review/) as HTMLAnchorElement
    expect(reviewLink.getAttribute('href')).toBe('/review')
  })

  it('renders the empty state when no transactions have been scanned', async () => {
    mockFetch({
      ...FULL_RESPONSE,
      score: 1,
      totals: { transactionsScanned: 0, spendTransactions: 0 },
    })
    render(
      <MemoryRouter initialEntries={['/data-quality']}>
        <DataQualityPage />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText(/No transactions yet/)).toBeInTheDocument())
    // The empty state should show an Import call-to-action.
    expect(screen.getByText(/Import transactions/)).toBeInTheDocument()
  })

  it('renders the loading state initially', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})), // never resolves
    )
    render(
      <MemoryRouter initialEntries={['/data-quality']}>
        <DataQualityPage />
      </MemoryRouter>,
    )
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })

  it('renders the error state when the fetch fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 500,
          statusText: 'Server Error',
          text: () => Promise.resolve('boom'),
        } as unknown as Response),
      ),
    )
    render(
      <MemoryRouter initialEntries={['/data-quality']}>
        <DataQualityPage />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
  })
})
