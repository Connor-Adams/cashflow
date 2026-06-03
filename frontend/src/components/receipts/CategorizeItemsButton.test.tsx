import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { CategorizeItemsButton } from './CategorizeItemsButton'

void React

vi.mock('@/lib/api', () => ({
  postJson: vi.fn(),
}))

import { postJson } from '@/lib/api'

const mockPostJson = postJson as ReturnType<typeof vi.fn>

describe('CategorizeItemsButton', () => {
  beforeEach(() => {
    mockPostJson.mockReset()
  })

  it('renders the button with correct label', () => {
    render(<CategorizeItemsButton />)
    expect(screen.getByRole('button', { name: /categorize items/i })).toBeInTheDocument()
  })

  it('calls postJson with the correct endpoint on click', async () => {
    mockPostJson.mockResolvedValueOnce({ categorized: 7 })
    render(<CategorizeItemsButton />)

    fireEvent.click(screen.getByRole('button', { name: /categorize items/i }))

    await waitFor(() => {
      expect(mockPostJson).toHaveBeenCalledWith('/api/external-orders/categorize-items')
    })
  })

  it('shows loading state while running', async () => {
    let resolve!: (v: { categorized: number }) => void
    mockPostJson.mockReturnValueOnce(
      new Promise<{ categorized: number }>((r) => {
        resolve = r
      }),
    )

    render(<CategorizeItemsButton />)
    fireEvent.click(screen.getByRole('button', { name: /categorize items/i }))

    expect(await screen.findByRole('button', { name: /categorizing/i })).toBeDisabled()

    resolve({ categorized: 7 })
  })

  it('shows result text when categorized > 0', async () => {
    mockPostJson.mockResolvedValueOnce({ categorized: 7 })
    render(<CategorizeItemsButton />)

    fireEvent.click(screen.getByRole('button', { name: /categorize items/i }))

    expect(await screen.findByText(/categorized 7 items/i)).toBeInTheDocument()
  })

  it('shows already-categorized text when categorized === 0', async () => {
    mockPostJson.mockResolvedValueOnce({ categorized: 0 })
    render(<CategorizeItemsButton />)

    fireEvent.click(screen.getByRole('button', { name: /categorize items/i }))

    expect(await screen.findByText(/already categorized/i)).toBeInTheDocument()
  })

  it('shows error message on failure', async () => {
    mockPostJson.mockRejectedValueOnce(new Error('Server exploded'))
    render(<CategorizeItemsButton />)

    fireEvent.click(screen.getByRole('button', { name: /categorize items/i }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Server exploded')
  })
})
