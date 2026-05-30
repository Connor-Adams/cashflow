import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import { MemoryRouter } from 'react-router-dom'
import { ToastProvider } from '@/components/ui/toast'
import { FeedbackPanel } from './FeedbackPanel'
import * as api from '@/lib/api'

function renderPanel(onOpenChange = vi.fn()) {
  render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <ToastProvider>
        <FeedbackPanel open onOpenChange={onOpenChange} />
      </ToastProvider>
    </MemoryRouter>,
  )
  return { onOpenChange }
}

/** Set the textarea value directly — instant + deterministic (avoids the
 *  per-keystroke races userEvent.type can hit under the full parallel run). */
function typeBody(value: string) {
  fireEvent.change(screen.getByLabelText(/what's on your mind/i), {
    target: { value },
  })
}

describe('FeedbackPanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('renders the title, category select with four options, textarea, and Send (AC#10)', () => {
    renderPanel()
    expect(screen.getByRole('heading', { name: /send us feedback/i })).toBeInTheDocument()
    const select = screen.getByLabelText(/category/i)
    expect(select).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Bug' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Feature request' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'This is confusing' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Other' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^send$/i })).toBeInTheDocument()
  })

  it('shows an inline error and blocks submit when the body is empty (AC#12)', async () => {
    const post = vi.spyOn(api, 'postJson')
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }))
    expect(
      await screen.findByText(/tell us a bit more \(at least 5 characters\)\./i),
    ).toBeInTheDocument()
    expect(post).not.toHaveBeenCalled()
  })

  it('shows an inline error and blocks submit when the body is too long (AC#12)', async () => {
    const post = vi.spyOn(api, 'postJson')
    renderPanel()
    typeBody('x'.repeat(2001))
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }))
    expect(await screen.findByText(/keep it under 2000 characters\./i)).toBeInTheDocument()
    expect(post).not.toHaveBeenCalled()
  })

  it('disables the button and shows "Sending…" while in flight (AC#11)', async () => {
    let resolve: (v: { id: number }) => void = () => {}
    vi.spyOn(api, 'postJson').mockImplementation(
      () => new Promise((r) => { resolve = r }),
    )
    renderPanel()
    typeBody('something is broken here')
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }))
    const sending = await screen.findByRole('button', { name: /sending/i })
    expect(sending).toBeDisabled()
    resolve({ id: 1 })
  })

  it('on success shows the thanks toast and closes the panel (AC#11)', async () => {
    vi.spyOn(api, 'postJson').mockResolvedValue({ id: 7 })
    const { onOpenChange } = renderPanel()
    typeBody('please add a dark theme')
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }))
    expect(await screen.findByText(/thanks — we got it\./i)).toBeInTheDocument()
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it('posts the chosen category and body to /api/feedback (AC#10)', async () => {
    const post = vi.spyOn(api, 'postJson').mockResolvedValue({ id: 9 })
    renderPanel()
    fireEvent.change(screen.getByLabelText(/category/i), { target: { value: 'feature' } })
    typeBody('a feature request body')
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }))
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    const [path, payload] = post.mock.calls[0]
    expect(path).toBe('/api/feedback')
    expect(payload).toMatchObject({
      category: 'feature',
      body: 'a feature request body',
      currentPath: '/dashboard',
    })
  })

  it('on error shows the error toast and preserves the entered text (AC#11)', async () => {
    vi.spyOn(api, 'postJson').mockRejectedValue(new Error('boom'))
    renderPanel()
    typeBody('do not lose this text')
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }))
    expect(await screen.findByText(/couldn't send\. try again\./i)).toBeInTheDocument()
    // Text is preserved so the user does not lose their note.
    expect(screen.getByLabelText(/what's on your mind/i)).toHaveValue('do not lose this text')
  })
})
