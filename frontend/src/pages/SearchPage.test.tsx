import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { SearchPage } from './SearchPage'

type FetchInput = RequestInfo | URL

function makeFetchStub(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input: FetchInput, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      return handler(url, init)
    })
}

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  cleanup()
})

describe('SearchPage', () => {
  it('renders example queries when no results yet', async () => {
    makeFetchStub((url) => {
      if (url.endsWith('/api/search/saved')) {
        return new Response(JSON.stringify([]), { status: 200 })
      }
      return new Response('not stubbed', { status: 500 })
    })
    render(
      <MemoryRouter>
        <SearchPage />
      </MemoryRouter>,
    )
    expect(screen.getByText(/Smart search/i)).toBeTruthy()
    expect(screen.getByText(/category:Groceries amount:>100/i)).toBeTruthy()
    await waitFor(() => {
      expect((globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.length).toBeGreaterThan(0)
    })
  })

  it('shows active-filter chips and result rows after a successful search', async () => {
    makeFetchStub((url) => {
      if (url.endsWith('/api/search/saved')) {
        return new Response(JSON.stringify([]), { status: 200 })
      }
      if (url.includes('/api/search?')) {
        return new Response(
          JSON.stringify({
            intent: {
              category: 'Groceries',
              amount: { op: '>', value: 100 },
              errors: [],
              isEmpty: false,
            },
            results: [
              {
                id: 1,
                date: '2026-04-01',
                merchantClean: 'Loblaws',
                amount: '-150.00',
                currency: 'CAD',
                finalCategory: 'Groceries',
                finalBusiness: false,
                isRecurring: false,
                reviewFlag: false,
                notes: null,
              },
            ],
            total: 1,
            limit: 50,
            offset: 0,
          }),
          { status: 200 },
        )
      }
      return new Response('not stubbed', { status: 500 })
    })

    render(
      <MemoryRouter>
        <SearchPage />
      </MemoryRouter>,
    )

    const input = screen.getByLabelText(/Search transactions/i)
    fireEvent.change(input, { target: { value: 'category:Groceries amount:>100' } })
    const button = screen.getByRole('button', { name: /Search/i })
    fireEvent.click(button)

    await waitFor(() => {
      expect(screen.getByText(/category: Groceries/i)).toBeTruthy()
      expect(screen.getByText(/amount: >100/i)).toBeTruthy()
      expect(screen.getByText(/Loblaws/i)).toBeTruthy()
    })
  })

  it('shows parser errors when the server returns intent.errors', async () => {
    makeFetchStub((url) => {
      if (url.endsWith('/api/search/saved')) {
        return new Response(JSON.stringify([]), { status: 200 })
      }
      if (url.includes('/api/search?')) {
        return new Response(
          JSON.stringify({
            intent: {
              errors: ['Invalid amount filter: "abc"'],
              isEmpty: true,
            },
            results: [],
            total: 0,
            message: 'Type a query like ...',
          }),
          { status: 200 },
        )
      }
      return new Response('not stubbed', { status: 500 })
    })

    render(
      <MemoryRouter>
        <SearchPage />
      </MemoryRouter>,
    )

    const input = screen.getByLabelText(/Search transactions/i)
    fireEvent.change(input, { target: { value: 'amount:abc' } })
    fireEvent.click(screen.getByRole('button', { name: /Search/i }))

    await waitFor(() => {
      expect(screen.getByText(/Invalid amount filter/i)).toBeTruthy()
    })
  })

  it('renders saved searches and loads one when clicked', async () => {
    makeFetchStub((url) => {
      if (url.endsWith('/api/search/saved')) {
        return new Response(
          JSON.stringify([
            {
              id: 1,
              userId: 1,
              name: 'big-grocery-runs',
              query: 'category:Groceries amount:>100',
              createdAt: '2026-05-26',
              updatedAt: '2026-05-26',
            },
          ]),
          { status: 200 },
        )
      }
      if (url.includes('/api/search?')) {
        return new Response(
          JSON.stringify({
            intent: {
              category: 'Groceries',
              amount: { op: '>', value: 100 },
              errors: [],
              isEmpty: false,
            },
            results: [],
            total: 0,
          }),
          { status: 200 },
        )
      }
      return new Response('not stubbed', { status: 500 })
    })

    render(
      <MemoryRouter>
        <SearchPage />
      </MemoryRouter>,
    )

    await waitFor(() => {
      expect(screen.getByText(/Saved searches/i)).toBeTruthy()
      expect(screen.getByText(/big-grocery-runs/i)).toBeTruthy()
    })
  })
})
