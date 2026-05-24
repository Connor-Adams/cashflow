import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ChatPage } from './ChatPage'
import { ToastProvider } from '@/components/ui/toast'

type FetchInput = RequestInfo | URL
type FetchInit = RequestInit | undefined

const ENABLED_STATUS = { openai: true, chat: true }

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  cleanup()
})

function wrap(node: React.ReactNode) {
  return (
    <MemoryRouter>
      <ToastProvider>{node}</ToastProvider>
    </MemoryRouter>
  )
}

/**
 * Build an SSE response body as a ReadableStream of bytes. Mirrors what
 * the backend writes: one `event:` line + one `data:` line per record,
 * records separated by a blank line.
 */
function sseResponse(events: Array<{ event: string; data: unknown }>): Response {
  const encoder = new TextEncoder()
  const text = events
    .map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
    .join('')
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text))
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('ChatPage', () => {
  it('renders thread list returned by /api/chat/threads', async () => {
    const threads = [
      {
        id: 1,
        userId: 1,
        title: 'Groceries split',
        archivedAt: null,
        lastMessageAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: 2,
        userId: 1,
        title: null,
        archivedAt: null,
        lastMessageAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: FetchInput) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/api/ai/status')) return jsonResponse(ENABLED_STATUS)
      if (url.endsWith('/api/chat/threads')) return jsonResponse(threads)
      if (url.includes('/api/chat/threads/1')) {
        return jsonResponse({
          thread: threads[0],
          messages: [],
          proposals: [],
        })
      }
      return jsonResponse({ error: 'not mocked' }, 404)
    })

    render(wrap(<ChatPage />))

    await waitFor(() => {
      expect(screen.getByText('Groceries split')).toBeInTheDocument()
    })
    expect(screen.getByText('Untitled')).toBeInTheDocument()
  })

  it('hides the composer when no thread is selected (shows empty state)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: FetchInput) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/api/ai/status')) return jsonResponse(ENABLED_STATUS)
      if (url.endsWith('/api/chat/threads')) return jsonResponse([])
      return jsonResponse({ error: 'not mocked' }, 404)
    })

    render(wrap(<ChatPage />))

    // Empty state appears.
    await waitFor(() => {
      expect(
        screen.getByText(/Ask anything about your transactions/i),
      ).toBeInTheDocument()
    })
    // Composer is NOT rendered when no thread selected.
    expect(screen.queryByLabelText('Chat message')).toBeNull()
    expect(screen.queryByLabelText('Send')).toBeNull()
  })

  it('renders a proposal card when a proposal event arrives via SSE', async () => {
    const thread = {
      id: 7,
      userId: 1,
      title: 'Test',
      archivedAt: null,
      lastMessageAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    const proposalRow = {
      id: 99,
      threadId: 7,
      messageId: 0,
      kind: 'bulk_patch' as const,
      payload: {},
      preview: { matched_count: 23, filter_summary: 'category=Groceries' },
      status: 'pending' as const,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      appliedAt: null,
      appliedResult: null,
      createdAt: new Date().toISOString(),
    }

    let refetchCount = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (input: FetchInput, init?: FetchInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.endsWith('/api/ai/status')) return jsonResponse(ENABLED_STATUS)
        if (url.endsWith('/api/chat/threads')) return jsonResponse([thread])
        if (url.endsWith('/api/chat/threads/7') && (!init || init.method == null || init.method === 'GET')) {
          // Initial fetch returns empty; post-stream refetch returns the
          // persisted proposal row so the card stays visible.
          refetchCount += 1
          if (refetchCount === 1) {
            return jsonResponse({ thread, messages: [], proposals: [] })
          }
          return jsonResponse({ thread, messages: [], proposals: [proposalRow] })
        }
        if (url.endsWith('/api/chat/threads/7/messages')) {
          return sseResponse([
            {
              event: 'proposal',
              data: {
                type: 'proposal',
                proposalId: 99,
                kind: 'bulk_patch',
                preview: { matched_count: 23, filter_summary: 'category=Groceries' },
              },
            },
            {
              event: 'assistant_done',
              data: { type: 'assistant_done', messageId: 100 },
            },
          ])
        }
        return jsonResponse({ error: `not mocked: ${url}` }, 404)
      },
    )

    render(wrap(<ChatPage />))

    // Wait for thread auto-selection + initial detail load.
    const textarea = await waitFor(() => screen.getByLabelText('Chat message'))

    // Send a message — this opens the SSE stream which yields the proposal event.
    fireEvent.change(textarea, { target: { value: 'hi' } })
    const sendBtn = screen.getByLabelText('Send')
    fireEvent.click(sendBtn)

    // Proposal card surfaces with the bulk_patch label.
    await waitFor(() => {
      expect(screen.getByText('Bulk patch')).toBeInTheDocument()
    })
    expect(screen.getByText('matches:')).toBeInTheDocument()
    expect(screen.getByText('23')).toBeInTheDocument()
    // Pending status badge + action buttons are visible.
    expect(screen.getByText('pending')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Apply$/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Reject$/ })).toBeInTheDocument()
  })

  it('renders a disabled banner when AI status reports openai=false', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: FetchInput) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/api/ai/status')) return jsonResponse({ openai: false, chat: false })
      if (url.endsWith('/api/chat/threads')) return jsonResponse([])
      return jsonResponse({ error: 'not mocked' }, 404)
    })

    render(wrap(<ChatPage />))

    await waitFor(() => {
      expect(screen.getByText(/Chat is disabled/i)).toBeInTheDocument()
    })
    expect(screen.getByText(/OpenAI is not configured/i)).toBeInTheDocument()
  })
})
