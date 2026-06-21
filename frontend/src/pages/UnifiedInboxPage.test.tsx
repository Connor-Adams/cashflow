import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { UnifiedInboxPage } from './UnifiedInboxPage'

type ReviewItem = {
  id: string
  source: string
  subject_type: string | null
  subject_id: string | null
  payload: Record<string, unknown>
  status_common: string
  native_status: string
  created_at: string
  resolved_at: string | null
}

const SAMPLE: ReviewItem[] = [
  {
    id: 'chat-proposal:3',
    source: 'chat-proposal',
    subject_type: 'chat-message',
    subject_id: '55',
    payload: { kind: 'bulk_patch', preview: { matchedCount: 4 } },
    status_common: 'pending',
    native_status: 'pending',
    created_at: '2026-05-04T00:00:00Z',
    resolved_at: null,
  },
  {
    id: 'cfo-briefing:200:brief-item-1',
    source: 'cfo-briefing',
    subject_type: 'subscription',
    subject_id: '12',
    payload: {
      id: 'brief-item-1',
      type: 'safe_to_spend_low',
      title: 'Safe-to-spend low',
      summary: 'Careful this week',
      severity: 'action',
      runId: 200,
    },
    status_common: 'pending',
    native_status: 'open',
    created_at: '2026-05-03T00:00:00Z',
    resolved_at: null,
  },
  {
    id: 'ai-review:100:rev-item-1',
    source: 'ai-review',
    subject_type: 'transaction',
    subject_id: '999',
    payload: {
      id: 'rev-item-1',
      type: 'subscription',
      title: 'Netflix recurring',
      summary: 'Looks like a subscription',
      severity: 'watch',
      runId: 100,
    },
    status_common: 'pending',
    native_status: 'suggested',
    created_at: '2026-05-02T00:00:00Z',
    resolved_at: null,
  },
  {
    id: 'ai-suggestion:7',
    source: 'ai-suggestion',
    subject_type: null,
    subject_id: null,
    payload: { kind: 'financial_insight', output: { headline: 'Spending up 20%' } },
    status_common: 'pending',
    native_status: 'suggested',
    created_at: '2026-05-01T00:00:00Z',
    resolved_at: null,
  },
]

/**
 * Capture every GET /api/review-items request URL so tests can assert the
 * query string the page builds from its filter state.
 */
function mockReviewItems(items: ReviewItem[]): { urls: string[] } {
  const urls: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = init?.method ?? 'GET'
      if (method === 'GET' && url.includes('/api/review-items')) {
        urls.push(url)
        // Honour the source filter so chip toggles change the rendered set.
        const parsed = new URL(url, 'http://localhost')
        const sourceParam = parsed.searchParams.get('source')
        let data = items
        if (sourceParam) {
          const wanted = new Set(sourceParam.split(','))
          data = items.filter((i) => wanted.has(i.source))
        }
        return new Response(JSON.stringify({ data, nextCursor: null }), { status: 200 })
      }
      return new Response('not found', { status: 404 })
    },
  )
  return { urls }
}

beforeEach(() => {
  vi.restoreAllMocks()
})
afterEach(() => {
  cleanup()
})

describe('UnifiedInboxPage', () => {
  it('renders the Inbox heading', async () => {
    mockReviewItems([])
    render(
      <MemoryRouter>
        <UnifiedInboxPage />
      </MemoryRouter>,
    )
    expect(await screen.findByRole('heading', { name: /Inbox/i })).toBeTruthy()
  })

  it('shows an empty state when there are no items', async () => {
    mockReviewItems([])
    render(
      <MemoryRouter>
        <UnifiedInboxPage />
      </MemoryRouter>,
    )
    await waitFor(() => screen.getByText(/no items/i))
    expect(screen.getByText(/no items/i)).toBeTruthy()
  })

  it('defaults to pending status and fetches with status=pending', async () => {
    const { urls } = mockReviewItems(SAMPLE)
    render(
      <MemoryRouter>
        <UnifiedInboxPage />
      </MemoryRouter>,
    )
    await waitFor(() => expect(urls.length).toBeGreaterThan(0))
    expect(urls[0]).toContain('status=pending')
  })

  it('renders one card per source from the response', async () => {
    mockReviewItems(SAMPLE)
    render(
      <MemoryRouter>
        <UnifiedInboxPage />
      </MemoryRouter>,
    )
    // Source-specific payload titles / summaries render.
    await waitFor(() => screen.getByText('Netflix recurring'))
    expect(screen.getByText('Safe-to-spend low')).toBeTruthy()
    expect(screen.getByText(/Spending up 20%/)).toBeTruthy()
    // chat-proposal card renders its kind.
    expect(screen.getByText(/bulk_patch/i)).toBeTruthy()
  })

  it('selecting a source in the dropdown refetches scoped to that source', async () => {
    const { urls } = mockReviewItems(SAMPLE)
    render(
      <MemoryRouter>
        <UnifiedInboxPage />
      </MemoryRouter>,
    )
    await waitFor(() => screen.getByText('Netflix recurring'))
    const sourceSelect = screen.getByLabelText(/Filter by source/i)
    fireEvent.change(sourceSelect, { target: { value: 'ai-review' } })
    await waitFor(() => {
      const last = urls[urls.length - 1]
      expect(last).toContain('source=ai-review')
    })
    // Only the ai-review card remains.
    await waitFor(() => expect(screen.queryByText('Safe-to-spend low')).toBeNull())
    expect(screen.getByText('Netflix recurring')).toBeTruthy()
  })

  it('selecting a status in the dropdown refetches scoped to that status', async () => {
    const { urls } = mockReviewItems(SAMPLE)
    render(
      <MemoryRouter>
        <UnifiedInboxPage />
      </MemoryRouter>,
    )
    await waitFor(() => screen.getByText('Netflix recurring'))
    const statusSelect = screen.getByLabelText(/Filter by status/i)
    fireEvent.change(statusSelect, { target: { value: 'resolved' } })
    await waitFor(() => {
      const last = urls[urls.length - 1]
      expect(last).toContain('status=resolved')
    })
  })

  it('does not render the legacy saved-views buttons', async () => {
    mockReviewItems(SAMPLE)
    render(
      <MemoryRouter>
        <UnifiedInboxPage />
      </MemoryRouter>,
    )
    await waitFor(() => screen.getByText('Netflix recurring'))
    expect(screen.queryByRole('button', { name: /AI suggestions \(pending\)/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /All resolved \(last 30 days\)/i })).toBeNull()
  })

  it('preselects source and status from a ?view= deep link', async () => {
    window.history.pushState({}, '', '/inbox?view=all-resolved-30d')
    const { urls } = mockReviewItems(SAMPLE)
    render(
      <MemoryRouter>
        <UnifiedInboxPage />
      </MemoryRouter>,
    )
    await waitFor(() => expect(urls.length).toBeGreaterThan(0))
    expect(urls[0]).toContain('status=resolved')
    // all-resolved view spans every source → no source param.
    expect(urls[0]).not.toContain('source=')
    window.history.pushState({}, '', '/')
  })

  it('clicking accept on an ai-review card POSTs to the per-source accept endpoint', async () => {
    const postSpy = vi.fn()
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        const method = init?.method ?? 'GET'
        if (method === 'GET' && url.includes('/api/review-items')) {
          return new Response(
            JSON.stringify({ data: [SAMPLE[2]], nextCursor: null }),
            { status: 200 },
          )
        }
        if (method === 'POST') {
          postSpy(url)
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        return new Response('not found', { status: 404 })
      },
    )
    render(
      <MemoryRouter>
        <UnifiedInboxPage />
      </MemoryRouter>,
    )
    const acceptBtn = await waitFor(() => screen.getByRole('button', { name: /^Accept$/i }))
    fireEvent.click(acceptBtn)
    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(1))
    expect(String(postSpy.mock.calls[0][0])).toContain(
      '/api/ai/reviews/100/items/rev-item-1/accept',
    )
  })

  it('counterparty_email_match: renders candidate name and Accept POSTs to interac accept endpoint', async () => {
    const emailMatchItem: ReviewItem = {
      id: 'ai-suggestion:42',
      source: 'ai-suggestion',
      subject_type: 'transaction',
      subject_id: '999',
      payload: {
        kind: 'counterparty_email_match',
        output: { name: 'Jane Doe', isSelf: false },
        transactionId: 999,
      },
      status_common: 'pending',
      native_status: 'suggested',
      created_at: '2026-06-01T00:00:00Z',
      resolved_at: null,
    }
    const postSpy = vi.fn()
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        const method = init?.method ?? 'GET'
        if (method === 'GET' && url.includes('/api/review-items')) {
          return new Response(
            JSON.stringify({ data: [emailMatchItem], nextCursor: null }),
            { status: 200 },
          )
        }
        if (method === 'POST') {
          postSpy(url, init?.body)
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        return new Response('not found', { status: 404 })
      },
    )
    render(
      <MemoryRouter>
        <UnifiedInboxPage />
      </MemoryRouter>,
    )
    // Candidate name renders.
    await waitFor(() => screen.getByText(/Link Jane Doe to this transfer/i))
    const applyBtn = screen.getByRole('button', { name: /^Apply$/i })
    fireEvent.click(applyBtn)
    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(1))
    const calledUrl = String(postSpy.mock.calls[0][0])
    expect(calledUrl).toContain('/api/transactions/999/interac-counterparty/accept')
    const calledBody = JSON.parse(String(postSpy.mock.calls[0][1])) as { suggestionId: unknown }
    expect(calledBody.suggestionId).toBe(42)
  })

  it('counterparty_email_match: Reject POSTs to standard ai/suggestions reject endpoint', async () => {
    const emailMatchItem: ReviewItem = {
      id: 'ai-suggestion:42',
      source: 'ai-suggestion',
      subject_type: 'transaction',
      subject_id: '999',
      payload: {
        kind: 'counterparty_email_match',
        output: { name: 'Jane Doe', isSelf: false },
        transactionId: 999,
      },
      status_common: 'pending',
      native_status: 'suggested',
      created_at: '2026-06-01T00:00:00Z',
      resolved_at: null,
    }
    const postSpy = vi.fn()
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        const method = init?.method ?? 'GET'
        if (method === 'GET' && url.includes('/api/review-items')) {
          return new Response(
            JSON.stringify({ data: [emailMatchItem], nextCursor: null }),
            { status: 200 },
          )
        }
        if (method === 'POST') {
          postSpy(url)
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        return new Response('not found', { status: 404 })
      },
    )
    render(
      <MemoryRouter>
        <UnifiedInboxPage />
      </MemoryRouter>,
    )
    await waitFor(() => screen.getByText(/Link Jane Doe to this transfer/i))
    const rejectBtn = screen.getByRole('button', { name: /^Reject$/i })
    fireEvent.click(rejectBtn)
    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(1))
    expect(String(postSpy.mock.calls[0][0])).toContain('/api/ai/suggestions/42/reject')
  })

  it('clicking apply on a chat-proposal card POSTs to the chat apply endpoint', async () => {
    const postSpy = vi.fn()
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        const method = init?.method ?? 'GET'
        if (method === 'GET' && url.includes('/api/review-items')) {
          return new Response(
            JSON.stringify({ data: [SAMPLE[0]], nextCursor: null }),
            { status: 200 },
          )
        }
        if (method === 'POST') {
          postSpy(url)
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        return new Response('not found', { status: 404 })
      },
    )
    render(
      <MemoryRouter>
        <UnifiedInboxPage />
      </MemoryRouter>,
    )
    const applyBtn = await waitFor(() => screen.getByRole('button', { name: /^Apply$/i }))
    fireEvent.click(applyBtn)
    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(1))
    expect(String(postSpy.mock.calls[0][0])).toContain('/api/chat/proposals/3/apply')
  })
})
