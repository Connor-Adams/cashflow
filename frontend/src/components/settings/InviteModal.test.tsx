import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { ToastProvider } from '@/components/ui/toast'
import { InviteModal } from './InviteModal'
import { buildInviteUrl } from './inviteLink'
import * as api from '@/lib/api'

function renderModal(onCreated = vi.fn()) {
  return render(
    <ToastProvider>
      <InviteModal open onOpenChange={() => {}} onCreated={onCreated} />
    </ToastProvider>,
  )
}

describe('buildInviteUrl', () => {
  it('builds a ?invite= query-param link against the current origin', () => {
    expect(buildInviteUrl('abc123')).toBe(`${window.location.origin}/?invite=abc123`)
  })
})

describe('InviteModal', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('renders the optional email field and a Generate submit (AC #4)', () => {
    renderModal()
    expect(screen.getByLabelText(/email \(for your records\)/i)).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /generate invite link/i }),
    ).toBeInTheDocument()
  })

  it('submitting POSTs /api/invites and shows the link with a Copy button (AC #5)', async () => {
    const postSpy = vi.spyOn(api, 'postJson').mockResolvedValue({
      id: 7,
      token: 'rawtok',
      tokenFragment: 'rawtok',
      optionalEmail: null,
      generatedAt: new Date().toISOString(),
      expiresAt: new Date().toISOString(),
    } as never)

    const onCreated = vi.fn()
    renderModal(onCreated)
    await userEvent.click(screen.getByRole('button', { name: /generate invite link/i }))

    await waitFor(() => expect(postSpy).toHaveBeenCalledWith('/api/invites', { optionalEmail: undefined }))
    // Link field shows the working ?invite= URL.
    const field = (await screen.findByLabelText(/invite link/i)) as HTMLInputElement
    expect(field.value).toBe(`${window.location.origin}/?invite=rawtok`)
    expect(screen.getByRole('button', { name: /copy link/i })).toBeInTheDocument()
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 7, token: 'rawtok' }))
  })

  it('passes a trimmed optionalEmail when provided', async () => {
    const postSpy = vi.spyOn(api, 'postJson').mockResolvedValue({
      id: 8,
      token: 't',
      tokenFragment: 't',
      optionalEmail: 'a@b.com',
      generatedAt: '',
      expiresAt: '',
    } as never)
    renderModal()
    await userEvent.type(screen.getByLabelText(/email \(for your records\)/i), '  a@b.com  ')
    await userEvent.click(screen.getByRole('button', { name: /generate invite link/i }))
    await waitFor(() =>
      expect(postSpy).toHaveBeenCalledWith('/api/invites', { optionalEmail: 'a@b.com' }),
    )
  })

  it('Copy writes the full URL to clipboard and shows a "Copied!" toast (AC #6)', async () => {
    vi.spyOn(api, 'postJson').mockResolvedValue({
      id: 9,
      token: 'tok9',
      tokenFragment: 'tok9',
      optionalEmail: null,
      generatedAt: '',
      expiresAt: '',
    } as never)
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    renderModal()
    await userEvent.click(screen.getByRole('button', { name: /generate invite link/i }))
    await screen.findByRole('button', { name: /copy link/i })
    await userEvent.click(screen.getByRole('button', { name: /copy link/i }))

    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/?invite=tok9`)
    expect(await screen.findByText('Copied!')).toBeInTheDocument()
  })

  it('shows a manual-copy fallback when clipboard write is denied', async () => {
    vi.spyOn(api, 'postJson').mockResolvedValue({
      id: 10,
      token: 'tok10',
      tokenFragment: 'tok10',
      optionalEmail: null,
      generatedAt: '',
      expiresAt: '',
    } as never)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    })

    renderModal()
    await userEvent.click(screen.getByRole('button', { name: /generate invite link/i }))
    await screen.findByRole('button', { name: /copy link/i })
    await userEvent.click(screen.getByRole('button', { name: /copy link/i }))

    expect(await screen.findByText(/select the link above and copy it manually/i)).toBeInTheDocument()
  })

  it('surfaces an error when invite creation fails', async () => {
    vi.spyOn(api, 'postJson').mockRejectedValue(new Error('boom'))
    renderModal()
    await userEvent.click(screen.getByRole('button', { name: /generate invite link/i }))
    expect(await screen.findByText('boom')).toBeInTheDocument()
  })
})
