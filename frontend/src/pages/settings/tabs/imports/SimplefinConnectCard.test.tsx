import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { SimplefinConnectCard } from './SimplefinConnectCard'
import type { SimplefinStatusResponse } from '@cashflow/shared'

const DISCONNECTED: SimplefinStatusResponse = {
  connected: false,
  status: 'disconnected',
  statusReason: null,
  lastSyncedAt: null,
  host: null,
}

const CONNECTED: SimplefinStatusResponse = {
  connected: true,
  status: 'connected',
  statusReason: null,
  lastSyncedAt: null,
  host: 'beta-bridge.simplefin.org',
}

function setupFetch(opts: {
  status?: SimplefinStatusResponse
  connect?: () => Response | Promise<Response>
} = {}) {
  const statusBody = opts.status ?? DISCONNECTED
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    if (url.includes('/api/simplefin/status')) {
      return new Response(JSON.stringify(statusBody), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (url.includes('/api/simplefin/connect') && init?.method === 'POST') {
      if (opts.connect) return opts.connect()
      return new Response(
        JSON.stringify({ status: 'connected', accountsFound: 2, accountsLinked: 1, unlinkedAccounts: [] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    return new Response('{}', { status: 200 })
  })
}

describe('SimplefinConnectCard', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('AC11: renders the empty state headline and Connect bank CTA', async () => {
    vi.stubGlobal('fetch', setupFetch({ status: DISCONNECTED }))
    render(<SimplefinConnectCard />)
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: /connect a us bank with simplefin/i }),
      ).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: /connect bank/i })).toBeInTheDocument()
    expect(screen.getByLabelText(/simplefin setup token/i)).toBeInTheDocument()
  })

  it('AC12: renders the connected state (status, Never synced yet, Disconnect)', async () => {
    vi.stubGlobal('fetch', setupFetch({ status: CONNECTED }))
    render(<SimplefinConnectCard />)
    await waitFor(() => {
      expect(screen.getByText(/connected/i)).toBeInTheDocument()
    })
    expect(screen.getByText(/beta-bridge\.simplefin\.org/i)).toBeInTheDocument()
    expect(screen.getByText(/never synced yet/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /disconnect/i })).toBeInTheDocument()
  })

  it('AC12: shows the generic error fallback and preserves the token on failed connect', async () => {
    const user = userEvent.setup()
    vi.stubGlobal(
      'fetch',
      setupFetch({
        status: DISCONNECTED,
        connect: () =>
          new Response(JSON.stringify({ error: 'claim_exchange_failed' }), {
            status: 502,
            headers: { 'Content-Type': 'application/json' },
          }),
      }),
    )
    render(<SimplefinConnectCard />)

    const field = await screen.findByLabelText(/simplefin setup token/i)
    await user.type(field, 'my-setup-token')
    await user.click(screen.getByRole('button', { name: /connect bank/i }))

    await waitFor(() => {
      expect(
        screen.getByText(/we couldn't connect your bank\. check that you pasted a fresh setup token/i),
      ).toBeInTheDocument()
    })
    // Token preserved for retry.
    expect((field as HTMLTextAreaElement).value).toBe('my-setup-token')
  })

  it('flips to the connected count after a successful connect', async () => {
    const user = userEvent.setup()
    // Status starts disconnected; after connect, the component re-fetches status.
    let connectedNow = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input)
        if (url.includes('/api/simplefin/status')) {
          return new Response(JSON.stringify(connectedNow ? CONNECTED : DISCONNECTED), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        if (url.includes('/api/simplefin/connect') && init?.method === 'POST') {
          connectedNow = true
          return new Response(
            JSON.stringify({ status: 'connected', accountsFound: 3, accountsLinked: 2, unlinkedAccounts: [] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }
        return new Response('{}', { status: 200 })
      }),
    )
    render(<SimplefinConnectCard />)
    const field = await screen.findByLabelText(/simplefin setup token/i)
    await user.type(field, 'tok')
    await user.click(screen.getByRole('button', { name: /connect bank/i }))
    await waitFor(() => {
      expect(screen.getByText(/3 accounts found, 2 linked/i)).toBeInTheDocument()
    })
  })
})
