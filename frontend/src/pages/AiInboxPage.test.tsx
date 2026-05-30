import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AiInboxPage } from './AiInboxPage'

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  cleanup()
})

function mockInbox(items: unknown[]) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.includes('/api/ai/inbox')) {
      return new Response(JSON.stringify({ items }), { status: 200 })
    }
    return new Response('not found', { status: 404 })
  })
}

describe('AiInboxPage', () => {
  it('renders an empty state when there are no items', () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ items: [] }), { status: 200 }),
    )
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AiInboxPage />
      </MemoryRouter>,
    )
    expect(html).toContain('AI Inbox')
  })

  it('sorts items by severity (action first, then watch, then info)', async () => {
    mockInbox([
      { id: 1, kind: 'financial_insight', createdAt: '2026-05-01T00:00:00Z', transactionId: null,
        summary: 'Low priority', severity: 'info', confidence: null, output: [] },
      { id: 2, kind: 'financial_insight', createdAt: '2026-05-02T00:00:00Z', transactionId: null,
        summary: 'Urgent thing', severity: 'action', confidence: null, output: [] },
      { id: 3, kind: 'financial_insight', createdAt: '2026-05-03T00:00:00Z', transactionId: null,
        summary: 'Mid thing', severity: 'watch', confidence: null, output: [] },
    ])
    render(
      <MemoryRouter>
        <AiInboxPage />
      </MemoryRouter>,
    )
    const items = await waitFor(() => {
      const found = screen.getAllByRole('listitem')
      if (found.length < 3) throw new Error('not yet rendered')
      return found
    })
    expect(items[0].textContent).toContain('Urgent thing')
    expect(items[1].textContent).toContain('Mid thing')
    expect(items[2].textContent).toContain('Low priority')
  })

  it('shows a count next to each tab label', async () => {
    mockInbox([
      { id: 10, kind: 'transaction_audit', createdAt: '2026-05-01T00:00:00Z', transactionId: null,
        summary: '2 issues found', severity: null, confidence: null, output: { issues: [{ id: 1 }, { id: 2 }] } },
      { id: 11, kind: 'financial_insight', createdAt: '2026-05-02T00:00:00Z', transactionId: null,
        summary: 'Something', severity: 'action', confidence: null, output: [] },
      { id: 12, kind: 'financial_insight', createdAt: '2026-05-03T00:00:00Z', transactionId: null,
        summary: 'Else', severity: 'watch', confidence: null, output: [] },
    ])
    render(
      <MemoryRouter>
        <AiInboxPage />
      </MemoryRouter>,
    )
    const allBtn = await waitFor(() => screen.getByRole('button', { name: /^All \(3\)/ }))
    const auditBtn = screen.getByRole('button', { name: /^Audit \(1\)/ })
    const insightsBtn = screen.getByRole('button', { name: /^Insights \(2\)/ })
    const rulesBtn = screen.getByRole('button', { name: /^Rules \(0\)/ })
    expect(allBtn).toBeTruthy()
    expect(auditBtn).toBeTruthy()
    expect(insightsBtn).toBeTruthy()
    expect(rulesBtn).toBeTruthy()
  })

  it('expands a multi-insight card to reveal each insight', async () => {
    mockInbox([
      {
        id: 20,
        kind: 'financial_insight',
        createdAt: '2026-05-01T00:00:00Z',
        transactionId: null,
        summary: 'Headline · 1 action, 1 info',
        severity: 'action',
        confidence: null,
        output: [
          { title: 'First insight', severity: 'action', supportingTransactionIds: [1, 2] },
          { title: 'Second insight', severity: 'info', supportingTransactionIds: [] },
        ],
      },
    ])
    render(
      <MemoryRouter>
        <AiInboxPage />
      </MemoryRouter>,
    )
    const toggle = await waitFor(() => screen.getByRole('button', { name: /Show 2 insights/ }))
    expect(screen.queryByText('First insight')).toBeNull()
    fireEvent.click(toggle)
    await waitFor(() => screen.getByText('First insight'))
    expect(screen.getByText('Second insight')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Hide details/ })).toBeTruthy()
  })

  it('renders a counterparty_promotion card with "Create Contact and link all" + "Ignore" buttons (#373)', async () => {
    mockInbox([
      {
        id: -10001,
        kind: 'counterparty_promotion',
        createdAt: '2026-05-01T00:00:00Z',
        transactionId: null,
        summary: '5 transactions with JANE DOE in the last 90 days · promote to Contact?',
        severity: null,
        confidence: null,
        output: {
          normalizedName: 'jane doe',
          sampleRaw: 'JANE DOE',
          supportCount: 5,
          exampleTransactionIds: [101, 102, 103, 104, 105],
        },
      },
    ])
    render(
      <MemoryRouter>
        <AiInboxPage />
      </MemoryRouter>,
    )
    await waitFor(() =>
      screen.getByText(/5 transactions with JANE DOE in the last 90 days/),
    )
    expect(
      screen.getByRole('button', { name: /Create Contact and link all/i }),
    ).toBeTruthy()
    expect(
      screen.getByRole('button', { name: /Ignore this name forever/i }),
    ).toBeTruthy()
  })

  it('clicking "Create Contact and link all" POSTs to the bulk-promote endpoint with normalizedName', async () => {
    const promotePayload = {
      normalizedName: 'jane doe',
      sampleRaw: 'JANE DOE',
      supportCount: 5,
      exampleTransactionIds: [101, 102, 103],
    }
    const postSpy = vi.fn()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = init?.method ?? 'GET'
      if (method === 'GET' && url.includes('/api/ai/inbox')) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: -10001,
                kind: 'counterparty_promotion',
                createdAt: '2026-05-01T00:00:00Z',
                transactionId: null,
                summary: '5 transactions with JANE DOE in the last 90 days · promote to Contact?',
                severity: null,
                confidence: null,
                output: promotePayload,
              },
            ],
          }),
          { status: 200 },
        )
      }
      if (method === 'POST' && url.includes('/api/transactions/counterparty/promote-bulk')) {
        postSpy(url, init?.body)
        return new Response(
          JSON.stringify({ contact: { id: 99, name: 'JANE DOE' }, linkedCount: 5 }),
          { status: 200 },
        )
      }
      return new Response('not found', { status: 404 })
    })
    render(
      <MemoryRouter>
        <AiInboxPage />
      </MemoryRouter>,
    )
    const btn = await waitFor(() =>
      screen.getByRole('button', { name: /Create Contact and link all/i }),
    )
    fireEvent.click(btn)
    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(1))
    const bodyStr = String(postSpy.mock.calls[0]?.[1] ?? '')
    expect(bodyStr).toContain('"normalizedName"')
    expect(bodyStr).toContain('jane doe')
  })

  it('clicking "Ignore this name forever" POSTs to the dismiss endpoint', async () => {
    const postSpy = vi.fn()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = init?.method ?? 'GET'
      if (method === 'GET' && url.includes('/api/ai/inbox')) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: -10001,
                kind: 'counterparty_promotion',
                createdAt: '2026-05-01T00:00:00Z',
                transactionId: null,
                summary: '4 transactions with SARAH KIM in the last 90 days · promote to Contact?',
                severity: null,
                confidence: null,
                output: {
                  normalizedName: 'sarah kim',
                  sampleRaw: 'SARAH KIM',
                  supportCount: 4,
                  exampleTransactionIds: [1, 2, 3, 4],
                },
              },
            ],
          }),
          { status: 200 },
        )
      }
      if (method === 'POST' && url.includes('/api/ai/counterparty-promotions/')) {
        postSpy(url)
        return new Response(JSON.stringify({ ok: true, id: 7 }), { status: 201 })
      }
      return new Response('not found', { status: 404 })
    })
    render(
      <MemoryRouter>
        <AiInboxPage />
      </MemoryRouter>,
    )
    const btn = await waitFor(() =>
      screen.getByRole('button', { name: /Ignore this name forever/i }),
    )
    fireEvent.click(btn)
    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(1))
    const calledUrl = String(postSpy.mock.calls[0]?.[0] ?? '')
    expect(calledUrl).toContain('sarah%20kim')
    expect(calledUrl).toContain('/dismiss')
  })
})
