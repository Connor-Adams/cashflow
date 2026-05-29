import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CounterpartyBackfillCard } from './CounterpartyBackfillCard'

type StatusBody = {
  running: boolean
  lastRunAt: string | null
  nextAllowedAt: string | null
  lastSummary: { processed: number; extracted: number; elapsedMs: number } | null
  rateLimitMs: number
}

const FRESH_STATUS: StatusBody = {
  running: false,
  lastRunAt: null,
  nextAllowedAt: null,
  lastSummary: null,
  rateLimitMs: 60 * 60 * 1000,
}

function ndjson(events: unknown[]): Response {
  const body = events.map((e) => JSON.stringify(e)).join('\n') + '\n'
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body))
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'application/x-ndjson' },
  })
}

function setupFetch(opts: {
  status?: StatusBody
  postResponse?: () => Promise<Response> | Response
} = {}) {
  const status = opts.status ?? FRESH_STATUS
  const post = opts.postResponse
  return vi.fn(async (input: RequestInfo, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    if (url.includes('/counterparty/backfill/status')) {
      return new Response(JSON.stringify(status), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (url.includes('/counterparty/backfill') && init?.method === 'POST') {
      if (post) return post()
      // Default: a stream with one progress + one summary event.
      return ndjson([
        { kind: 'progress', txnId: 1, merchantRaw: 'INTERAC E-TFR FROM JANE', counterpartyRaw: 'JANE' },
        { kind: 'summary', processed: 1, extracted: 1, skipped: 0, elapsedMs: 12, dryRun: false },
      ])
    }
    return new Response('{}', { status: 200 })
  })
}

describe('CounterpartyBackfillCard', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders heading, description, and primary CTA', async () => {
    vi.stubGlobal('fetch', setupFetch())
    render(<CounterpartyBackfillCard />)
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: /backfill counterparty on past imports/i }),
      ).toBeInTheDocument()
    })
    expect(
      screen.getByRole('button', { name: /backfill counterparty on past imports/i }),
    ).toBeInTheDocument()
  })

  it('streams progress events and renders a final summary', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('fetch', setupFetch())
    render(<CounterpartyBackfillCard />)

    const btn = await screen.findByRole('button', { name: /backfill counterparty on past imports/i })
    await user.click(btn)
    // Confirm dialog appears with a "Run backfill" button — click it.
    const confirmBtn = await screen.findByRole('button', { name: /run backfill/i })
    await user.click(confirmBtn)

    await waitFor(() => {
      expect(screen.getByText(/processed 1.*extracted 1/i)).toBeInTheDocument()
    })
  })

  it('disables the button and shows next-allowed message when rate-limited', async () => {
    const limited: StatusBody = {
      ...FRESH_STATUS,
      lastRunAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      nextAllowedAt: new Date(Date.now() + 55 * 60 * 1000).toISOString(),
      lastSummary: { processed: 12, extracted: 4, elapsedMs: 150 },
    }
    vi.stubGlobal('fetch', setupFetch({ status: limited }))
    render(<CounterpartyBackfillCard />)

    const btn = await screen.findByRole('button', { name: /backfill counterparty on past imports/i })
    await waitFor(() => expect(btn).toBeDisabled())
    expect(screen.getByText(/rate.limited|available again/i)).toBeInTheDocument()
  })

  it('shows the last run summary when one exists', async () => {
    const past: StatusBody = {
      ...FRESH_STATUS,
      lastRunAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      lastSummary: { processed: 42, extracted: 9, elapsedMs: 250 },
    }
    vi.stubGlobal('fetch', setupFetch({ status: past }))
    render(<CounterpartyBackfillCard />)
    await waitFor(() => {
      expect(screen.getByText(/last run.*42/i)).toBeInTheDocument()
      expect(screen.getByText(/9 counterparties/i)).toBeInTheDocument()
    })
  })
})
