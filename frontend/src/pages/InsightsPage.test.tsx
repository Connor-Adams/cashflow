import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { InsightsPage } from './InsightsPage'

type FakeInsight = {
  id: number
  type: string
  severity: 'info' | 'warning' | 'critical'
  title: string
  description: string | null
  entityType: string | null
  entityId: number | null
  status: 'open' | 'dismissed' | 'resolved'
  metadata: unknown
  detectedAt: string
  createdAt: string
  updatedAt: string
}

function makeRow(p: Partial<FakeInsight>): FakeInsight {
  return {
    id: 1,
    type: 'duplicate_transactions',
    severity: 'warning',
    title: 'Possible duplicate at Costco',
    description: '2 charges of 50.00 CAD',
    entityType: 'transaction',
    entityId: 99,
    status: 'open',
    metadata: {},
    detectedAt: '2026-05-10T12:00:00Z',
    createdAt: '2026-05-10T12:00:00Z',
    updatedAt: '2026-05-10T12:00:00Z',
    ...p,
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  cleanup()
})

function mockApi(items: FakeInsight[]) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.endsWith('/api/insights') && (!init || !init.method || init.method === 'GET')) {
      return new Response(JSON.stringify({ data: items }), { status: 200 })
    }
    if (url.endsWith('/api/insights/run')) {
      return new Response(JSON.stringify({ created: 0, refreshed: 0, total: 0 }), { status: 200 })
    }
    if (url.match(/\/api\/insights\/\d+$/) && init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body))
      const id = Number(url.split('/').pop())
      const original = items.find((i) => i.id === id) || items[0]
      return new Response(JSON.stringify({ ...original, status: body.status }), { status: 200 })
    }
    return new Response('not found', { status: 404 })
  })
}

describe('InsightsPage', () => {
  it('renders an empty state when there are no items', async () => {
    mockApi([])
    render(
      <MemoryRouter>
        <InsightsPage />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText(/Nothing here yet/i)).toBeTruthy())
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Insights')
  })

  it('sorts items by severity (critical, warning, info)', async () => {
    mockApi([
      makeRow({ id: 1, severity: 'info', title: 'Low' }),
      makeRow({ id: 2, severity: 'critical', title: 'High' }),
      makeRow({ id: 3, severity: 'warning', title: 'Mid' }),
    ])
    render(
      <MemoryRouter>
        <InsightsPage />
      </MemoryRouter>,
    )
    const rows = await waitFor(() => {
      const found = screen.getAllByTestId('insight-row')
      if (found.length < 3) throw new Error('not yet rendered')
      return found
    })
    expect(rows[0].textContent).toContain('High')
    expect(rows[1].textContent).toContain('Mid')
    expect(rows[2].textContent).toContain('Low')
  })

  it('shows counts per status tab', async () => {
    mockApi([
      makeRow({ id: 1, status: 'open' }),
      makeRow({ id: 2, status: 'open' }),
      makeRow({ id: 3, status: 'dismissed' }),
    ])
    render(
      <MemoryRouter>
        <InsightsPage />
      </MemoryRouter>,
    )
    const openBtn = await waitFor(() => screen.getByRole('button', { name: /^Open \(2\)/ }))
    expect(openBtn).toBeTruthy()
    const dismissedBtn = screen.getByRole('button', { name: /^Dismissed \(1\)/ })
    expect(dismissedBtn).toBeTruthy()
    const resolvedBtn = screen.getByRole('button', { name: /^Resolved \(0\)/ })
    expect(resolvedBtn).toBeTruthy()
  })

  it('dismisses an open insight via PATCH (optimistic update)', async () => {
    mockApi([makeRow({ id: 42, status: 'open', title: 'Open thing' })])
    render(
      <MemoryRouter>
        <InsightsPage />
      </MemoryRouter>,
    )
    const dismissBtn = await waitFor(() => screen.getByRole('button', { name: 'Dismiss' }))
    fireEvent.click(dismissBtn)
    // After dismissing, the row should disappear from the Open tab
    await waitFor(() => {
      const rows = screen.queryAllByTestId('insight-row')
      expect(rows.length).toBe(0)
    })
  })

  it('renders View link only when entityType is present', async () => {
    mockApi([
      makeRow({ id: 1, title: 'With link', entityType: 'transaction', entityId: 5 }),
      makeRow({ id: 2, title: 'No entity', entityType: null, entityId: null }),
    ])
    render(
      <MemoryRouter>
        <InsightsPage />
      </MemoryRouter>,
    )
    const rows = await waitFor(() => {
      const found = screen.getAllByTestId('insight-row')
      if (found.length < 2) throw new Error('not yet rendered')
      return found
    })
    // Locate each row by content (sort is by severity, then id desc — id-sensitive)
    const withLinkRow = rows.find((r) => r.textContent?.includes('With link'))
    const noEntityRow = rows.find((r) => r.textContent?.includes('No entity'))
    expect(withLinkRow).toBeTruthy()
    expect(noEntityRow).toBeTruthy()
    expect(withLinkRow!.querySelector('a')).toBeTruthy()
    expect(noEntityRow!.querySelector('a')).toBeNull()
  })

  it('reopens a dismissed insight when on the Dismissed tab', async () => {
    mockApi([makeRow({ id: 7, status: 'dismissed', title: 'Was dismissed' })])
    render(
      <MemoryRouter>
        <InsightsPage />
      </MemoryRouter>,
    )
    const dismissedTab = await waitFor(() =>
      screen.getByRole('button', { name: /^Dismissed \(1\)/ }),
    )
    fireEvent.click(dismissedTab)
    const reopenBtn = await waitFor(() => screen.getByRole('button', { name: 'Reopen' }))
    fireEvent.click(reopenBtn)
    await waitFor(() => {
      // After reopening, the row leaves the Dismissed tab (tab still has count 0
      // because state mutated optimistically).
      expect(screen.queryAllByTestId('insight-row').length).toBe(0)
    })
  })
})
