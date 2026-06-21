import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { MatchUnlinkedButton } from './MatchUnlinkedButton'

void React

vi.mock('@/lib/api', () => ({
  postJson: vi.fn(),
}))

import { postJson } from '@/lib/api'

const mockPostJson = postJson as ReturnType<typeof vi.fn>

describe('MatchUnlinkedButton', () => {
  beforeEach(() => {
    mockPostJson.mockReset()
  })

  it('renders the button with correct label', () => {
    render(<MatchUnlinkedButton />)
    expect(screen.getByRole('button', { name: /match unlinked receipts/i })).toBeInTheDocument()
  })

  it('calls postJson with the correct endpoint on click', async () => {
    mockPostJson.mockResolvedValueOnce({ processed: 5, linksCreated: 3 })
    render(<MatchUnlinkedButton />)

    fireEvent.click(screen.getByRole('button', { name: /match unlinked receipts/i }))

    await waitFor(() => {
      expect(mockPostJson).toHaveBeenCalledWith('/api/external-orders/match-unlinked')
    })
  })

  it('shows loading state while running', async () => {
    let resolve!: (v: { processed: number; linksCreated: number }) => void
    mockPostJson.mockReturnValueOnce(
      new Promise<{ processed: number; linksCreated: number }>((r) => {
        resolve = r
      }),
    )

    render(<MatchUnlinkedButton />)
    fireEvent.click(screen.getByRole('button', { name: /match unlinked receipts/i }))

    expect(await screen.findByRole('button', { name: /matching/i })).toBeDisabled()

    resolve({ processed: 5, linksCreated: 3 })
  })

  it('shows result text when linksCreated > 0', async () => {
    mockPostJson.mockResolvedValueOnce({ processed: 5, linksCreated: 3 })
    render(<MatchUnlinkedButton />)

    fireEvent.click(screen.getByRole('button', { name: /match unlinked receipts/i }))

    expect(await screen.findByText(/linked 3 of 5 receipts/i)).toBeInTheDocument()
  })

  it('shows "No new matches found" when linksCreated === 0', async () => {
    mockPostJson.mockResolvedValueOnce({ processed: 4, linksCreated: 0 })
    render(<MatchUnlinkedButton />)

    fireEvent.click(screen.getByRole('button', { name: /match unlinked receipts/i }))

    expect(await screen.findByText(/no new matches found/i)).toBeInTheDocument()
  })

  it('shows error message on failure', async () => {
    mockPostJson.mockRejectedValueOnce(new Error('Server exploded'))
    render(<MatchUnlinkedButton />)

    fireEvent.click(screen.getByRole('button', { name: /match unlinked receipts/i }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Server exploded')
  })
})
