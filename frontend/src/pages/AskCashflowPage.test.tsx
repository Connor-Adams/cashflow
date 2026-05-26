import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AskCashflowPage } from './AskCashflowPage'

vi.mock('@/hooks/useAiStatus', () => ({
  useAiStatus: () => ({ openai: true, chat: true }),
}))

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  cleanup()
})

describe('AskCashflowPage', () => {
  it('renders the command-bar placeholder and example prompts', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AskCashflowPage />
      </MemoryRouter>,
    )
    expect(html).toContain('Ask Cashflow')
    expect(html).toContain('How much did I spend on Restaurants last month?')
  })

  it('renders an answer with totals and source transactions after a successful query', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/api/ai/query')) {
        return new Response(
          JSON.stringify({
            question: 'restaurants?',
            intent: { intent: 'transaction_summary', filters: { category: 'Restaurants' } },
            answer: {
              headline: '75.00 CAD across 3 transactions',
              totalsByCurrency: [{ currency: 'CAD', total: -75, count: 3 }],
            },
            sources: [
              { id: 1, date: '2026-05-01', merchant: 'Resto A', amount: -25, currency: 'CAD', category: 'Restaurants' },
              { id: 2, date: '2026-05-02', merchant: 'Resto B', amount: -25, currency: 'CAD', category: 'Restaurants' },
            ],
            meta: { model: 'gpt-4o-mini', promptVersion: 'nl-query-v1', latencyMs: 12 },
          }),
          { status: 200 },
        )
      }
      return new Response('not found', { status: 404 })
    })
    render(
      <MemoryRouter>
        <AskCashflowPage />
      </MemoryRouter>,
    )
    const input = screen.getByLabelText(/Ask Cashflow/i)
    fireEvent.change(input, { target: { value: 'restaurants?' } })
    fireEvent.click(screen.getByRole('button', { name: /^Ask$/ }))
    await waitFor(() => {
      expect(screen.getByText(/75.00 CAD across 3 transactions/)).toBeTruthy()
    })
    // Source rows render
    expect(screen.getByText('Resto A')).toBeTruthy()
    expect(screen.getByText('Resto B')).toBeTruthy()
  })

  it('shows an error message when the API call fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify({ error: 'intent "drop_database" is not supported' }), { status: 400 })
    })
    render(
      <MemoryRouter>
        <AskCashflowPage />
      </MemoryRouter>,
    )
    const input = screen.getByLabelText(/Ask Cashflow/i)
    fireEvent.change(input, { target: { value: 'destroy stuff' } })
    fireEvent.click(screen.getByRole('button', { name: /^Ask$/ }))
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('not supported')
    })
  })
})
