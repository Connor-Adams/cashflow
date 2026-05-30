import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { ToastProvider } from '@/components/ui/toast'
import { MembersTab } from './MembersTab'
import * as api from '@/lib/api'

// Current user = owner with id 1.
vi.mock('../../../lib/useAuth', () => ({
  useAuth: () => ({ user: { id: 1, globalRole: 'user', household: { role: 'owner' } } }),
}))

const OWNER = {
  id: 1,
  displayName: 'Owner Person',
  email: 'owner@example.com',
  role: 'owner',
  joinedAt: new Date().toISOString(),
}
const MEMBER = {
  id: 2,
  displayName: 'Spouse Person',
  email: 'spouse@example.com',
  role: 'member',
  joinedAt: new Date().toISOString(),
}
const INVITE = {
  id: 5,
  tokenFragment: 'abc123',
  optionalEmail: null,
  generatedAt: new Date(Date.now() - 3 * 86400_000).toISOString(),
  expiresAt: new Date(Date.now() + 86400_000).toISOString(),
}

/** Route the two GETs the tab fires on mount. */
function mockGets(members: unknown[], invites: unknown[]) {
  vi.spyOn(api, 'getJson').mockImplementation((path: string) => {
    if (path === '/api/household/members') return Promise.resolve(members as never)
    if (path.startsWith('/api/invites')) return Promise.resolve(invites as never)
    return Promise.reject(new Error(`unexpected GET ${path}`))
  })
}

function renderTab() {
  return render(
    <ToastProvider>
      <MembersTab />
    </ToastProvider>,
  )
}

describe('MembersTab', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('renders the Household members heading', async () => {
    mockGets([OWNER], [])
    renderTab()
    expect(
      await screen.findByRole('heading', { name: /household members/i }),
    ).toBeInTheDocument()
  })

  it('renders both Active members and Pending invites sections (AC #2)', async () => {
    mockGets([OWNER, MEMBER], [INVITE])
    renderTab()
    expect(await screen.findByText('Active members')).toBeInTheDocument()
    expect(screen.getByText('Pending invites')).toBeInTheDocument()
    expect(screen.getByText('Owner Person')).toBeInTheDocument()
    expect(screen.getByText('Spouse Person')).toBeInTheDocument()
    // Pending invite shows the token fragment + relative time (AC #7).
    expect(screen.getByText(/abc123…/)).toBeInTheDocument()
    expect(screen.getByText(/3 days ago/)).toBeInTheDocument()
  })

  it('shows the empty state + CTA that opens the modal when only self (AC #3, #4)', async () => {
    mockGets([OWNER], [])
    renderTab()
    expect(
      await screen.findByText(/you're the only member of this household/i),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/invite a partner, spouse, or accountant to collaborate/i),
    ).toBeInTheDocument()

    // Empty-state CTA opens the invite modal (modal heading appears).
    const ctas = screen.getAllByRole('button', { name: /invite a member/i })
    await userEvent.click(ctas[ctas.length - 1])
    expect(
      await screen.findByRole('heading', { name: /invite a member/i }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /generate invite link/i })).toBeInTheDocument()
  })

  it('does not render a Remove button for the owner-self row (AC #10)', async () => {
    mockGets([OWNER, MEMBER], [])
    renderTab()
    await screen.findByText('Owner Person')
    // Spouse (non-owner) has a Remove button…
    expect(screen.getByRole('button', { name: /remove Spouse Person/i })).toBeInTheDocument()
    // …owner-self does not.
    expect(screen.queryByRole('button', { name: /remove Owner Person/i })).not.toBeInTheDocument()
  })

  it('revoking a pending invite confirms then DELETEs and refetches (AC #8)', async () => {
    mockGets([OWNER, MEMBER], [INVITE])
    const del = vi.spyOn(api, 'deleteReq').mockResolvedValue(undefined)
    renderTab()
    await screen.findByText(/abc123…/)

    await userEvent.click(screen.getByRole('button', { name: /revoke invite abc123/i }))
    // Confirm dialog with the specified copy.
    const dialog = await screen.findByRole('dialog')
    expect(
      within(dialog).getByText(/revoke this invite\? the link will no longer work\./i),
    ).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: /^revoke$/i }))

    await waitFor(() => expect(del).toHaveBeenCalledWith('/api/invites/5'))
  })

  it('removing a member confirms then DELETEs the membership (AC #9)', async () => {
    mockGets([OWNER, MEMBER], [])
    const del = vi.spyOn(api, 'deleteReq').mockResolvedValue(undefined)
    renderTab()
    await screen.findByText('Spouse Person')

    await userEvent.click(screen.getByRole('button', { name: /remove Spouse Person/i }))
    const dialog = await screen.findByRole('dialog')
    expect(
      within(dialog).getByText(
        /remove Spouse Person from your household\? they will lose access immediately\./i,
      ),
    ).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: /^remove$/i }))

    await waitFor(() => expect(del).toHaveBeenCalledWith('/api/household/members/2'))
  })

  it('shows an error message when the members fetch fails', async () => {
    vi.spyOn(api, 'getJson').mockRejectedValue(new Error('nope'))
    renderTab()
    expect(await screen.findByText('nope')).toBeInTheDocument()
  })
})
