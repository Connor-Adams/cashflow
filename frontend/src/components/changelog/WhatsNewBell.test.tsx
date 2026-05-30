import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { it, expect, vi, beforeEach } from 'vitest'
import * as api from '@/lib/api'
import { WhatsNewBell } from './WhatsNewBell'

beforeEach(() => {
  vi.restoreAllMocks()
})

it('shows badge when latest is unread, opens modal, and acknowledges', async () => {
  vi.spyOn(api, 'getJson').mockResolvedValue({
    version: 'v0.13.52', title: 'Newer', publishedAt: '2026-05-30T01:22:39Z',
    html: '<p>New things</p>', unread: true,
  } as never)
  const patchSpy = vi.spyOn(api, 'patchJson').mockResolvedValue({ ok: true } as never)

  render(<WhatsNewBell />)

  expect(await screen.findByTestId('whats-new-badge')).toBeInTheDocument()
  await userEvent.click(screen.getByTestId('whats-new-pill'))
  expect(await screen.findByText('New things')).toBeInTheDocument()

  await userEvent.click(screen.getByRole('button', { name: /got it/i }))
  await waitFor(() =>
    expect(patchSpy).toHaveBeenCalledWith('/api/changelog/seen', { version: 'v0.13.52' }),
  )

  // acknowledge clears the badge optimistically...
  await waitFor(() =>
    expect(screen.queryByTestId('whats-new-badge')).not.toBeInTheDocument(),
  )
  // ...and closes the modal
  await waitFor(() =>
    expect(screen.queryByText('New things')).not.toBeInTheDocument(),
  )
})

it('renders nothing when changelog is empty', async () => {
  vi.spyOn(api, 'getJson').mockResolvedValue({ empty: true } as never)
  const { container } = render(<WhatsNewBell />)
  await waitFor(() => expect(container).toBeEmptyDOMElement())
})

it('renders no badge when latest is already read', async () => {
  vi.spyOn(api, 'getJson').mockResolvedValue({
    version: 'v0.13.52', title: 'Newer', publishedAt: '2026-05-30T01:22:39Z',
    html: '<p>x</p>', unread: false,
  } as never)
  render(<WhatsNewBell />)
  expect(await screen.findByTestId('whats-new-pill')).toBeInTheDocument()
  expect(screen.queryByTestId('whats-new-badge')).not.toBeInTheDocument()
})
