import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { SimplefinAccountLinkStep } from './SimplefinAccountLinkStep'
import type { Account, SimplefinAccountLinkState } from '@cashflow/shared'

function account(id: number, name: string): Account {
  return {
    id,
    name,
    owner: 'me',
    householdId: 1,
    ownerUserId: 1,
    visibility: 'private',
    accountType: 'checking',
    shortCode: null,
    defaultCurrency: 'CAD',
    closedAt: null,
  }
}

/**
 * Stub fetch for the link step: serves GET /api/simplefin/accounts (the
 * discovered list), GET /api/accounts (household accounts), and the
 * link/unlink mutations via the `onMutate` hook so each test can assert the
 * call and choose the response.
 */
function setupFetch(opts: {
  discovered: SimplefinAccountLinkState[]
  household?: Account[]
  onLink?: (simplefinId: string, body: unknown) => Response | Promise<Response>
}) {
  const household = opts.household ?? [account(42, 'Chequing (RBC)')]
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (url.includes('/api/simplefin/accounts') && method === 'GET') {
      return new Response(JSON.stringify({ accounts: opts.discovered }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (url.endsWith('/api/accounts') && method === 'GET') {
      return new Response(JSON.stringify(household), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const linkMatch = url.match(/\/api\/simplefin\/accounts\/([^/]+)\/link$/)
    if (linkMatch && method === 'POST') {
      const simplefinId = decodeURIComponent(linkMatch[1])
      const body = init?.body ? JSON.parse(String(init.body)) : {}
      if (opts.onLink) return opts.onLink(simplefinId, body)
      return new Response(JSON.stringify({ simplefinId, linkedAccountId: body.accountId ?? 99 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response('{}', { status: 200 })
  })
}

describe('SimplefinAccountLinkStep', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('AC10: renders discovered accounts with mixed link state', async () => {
    vi.stubGlobal(
      'fetch',
      setupFetch({
        discovered: [
          { simplefinId: 'ACT-1', name: 'Joint Chequing', linkedAccountId: 42, suggestedAccountId: 42, alreadyLinkedElsewhere: false },
          { simplefinId: 'ACT-2', name: 'Savings', linkedAccountId: null, suggestedAccountId: null, alreadyLinkedElsewhere: false },
          { simplefinId: 'ACT-3', name: 'Shared', linkedAccountId: null, suggestedAccountId: 7, alreadyLinkedElsewhere: true },
        ],
      }),
    )
    render(<SimplefinAccountLinkStep />)
    await waitFor(() => expect(screen.getByText(/link your accounts/i)).toBeInTheDocument())
    // Linked row shows the linked summary with Unlink.
    expect(screen.getByText(/Joint Chequing/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /unlink/i })).toBeInTheDocument()
    // alreadyLinkedElsewhere row surfaces the warning.
    expect(
      screen.getByText(/already linked under another household member/i),
    ).toBeInTheDocument()
  })

  it('AC10: linking to an existing account updates the row to the linked summary', async () => {
    const user = userEvent.setup()
    vi.stubGlobal(
      'fetch',
      setupFetch({
        discovered: [
          { simplefinId: 'ACT-2', name: 'Savings', linkedAccountId: null, suggestedAccountId: null, alreadyLinkedElsewhere: false },
        ],
        household: [account(42, 'Chequing (RBC)')],
      }),
    )
    render(<SimplefinAccountLinkStep />)
    await waitFor(() => expect(screen.getByText('Savings')).toBeInTheDocument())

    await user.selectOptions(screen.getByLabelText(/existing account/i), '42')
    await user.click(screen.getByRole('button', { name: /^link to existing account$/i }))

    await waitFor(() =>
      expect(screen.getByText(/Chequing \(RBC\)/)).toBeInTheDocument(),
    )
    expect(screen.getByRole('button', { name: /unlink/i })).toBeInTheDocument()
  })

  it('AC9: a 409 already_linked response shows the warning and does not link', async () => {
    const user = userEvent.setup()
    vi.stubGlobal(
      'fetch',
      setupFetch({
        discovered: [
          { simplefinId: 'ACT-2', name: 'Savings', linkedAccountId: null, suggestedAccountId: null, alreadyLinkedElsewhere: false },
        ],
        household: [account(42, 'Chequing (RBC)')],
        onLink: () =>
          new Response(JSON.stringify({ error: 'already_linked', ownedByCurrentUser: false }), {
            status: 409,
            headers: { 'Content-Type': 'application/json' },
          }),
      }),
    )
    render(<SimplefinAccountLinkStep />)
    await waitFor(() => expect(screen.getByText('Savings')).toBeInTheDocument())

    await user.selectOptions(screen.getByLabelText(/existing account/i), '42')
    await user.click(screen.getByRole('button', { name: /^link to existing account$/i }))

    await waitFor(() =>
      expect(
        screen.getByText(/already linked under another household member/i),
      ).toBeInTheDocument(),
    )
    // Row stays unlinked (no Unlink control appeared).
    expect(screen.queryByRole('button', { name: /unlink/i })).not.toBeInTheDocument()
  })

  it('AC10: Skip for now leaves the account unlinked and advances', async () => {
    const user = userEvent.setup()
    vi.stubGlobal(
      'fetch',
      setupFetch({
        discovered: [
          { simplefinId: 'ACT-2', name: 'Savings', linkedAccountId: null, suggestedAccountId: null, alreadyLinkedElsewhere: false },
        ],
      }),
    )
    render(<SimplefinAccountLinkStep />)
    await waitFor(() => expect(screen.getByText('Savings')).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: /skip for now/i }))

    await waitFor(() => expect(screen.getByText(/skipped/i)).toBeInTheDocument())
    expect(screen.getByTestId('simplefin-all-set')).toBeInTheDocument()
  })

  it('shows the empty state when no accounts are discovered', async () => {
    vi.stubGlobal('fetch', setupFetch({ discovered: [] }))
    render(<SimplefinAccountLinkStep />)
    await waitFor(() =>
      expect(screen.getByText(/didn.t return any accounts/i)).toBeInTheDocument(),
    )
  })

  it('shows a retry-able error when the discovery fetch fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
        if (String(input).includes('/api/simplefin/accounts')) {
          return new Response(JSON.stringify({ error: 'discovery_failed' }), { status: 502 })
        }
        return new Response('[]', { status: 200 })
      }),
    )
    render(<SimplefinAccountLinkStep />)
    await waitFor(() =>
      expect(screen.getByText(/couldn.t load your simplefin accounts/i)).toBeInTheDocument(),
    )
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument()
  })

  it('AC10: creating a new account links it in one call', async () => {
    const user = userEvent.setup()
    vi.stubGlobal(
      'fetch',
      setupFetch({
        discovered: [
          { simplefinId: 'ACT-9', name: 'Brokerage', linkedAccountId: null, suggestedAccountId: null, alreadyLinkedElsewhere: false },
        ],
        household: [],
        onLink: (simplefinId, body) => {
          expect((body as { create?: unknown }).create).toBeTruthy()
          return new Response(JSON.stringify({ simplefinId, linkedAccountId: 500 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        },
      }),
    )
    render(<SimplefinAccountLinkStep />)
    await waitFor(() => expect(screen.getByText('Brokerage')).toBeInTheDocument())

    await user.selectOptions(screen.getByLabelText(/link mode/i), 'create')
    await user.click(screen.getByRole('button', { name: /^create a new account$/i }))

    await waitFor(() => expect(screen.getByRole('button', { name: /unlink/i })).toBeInTheDocument())
  })
})
