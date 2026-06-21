import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { SenderSuggestions } from './GmailSection'

vi.mock('@/lib/api', () => ({
  getJson: vi.fn(),
  postJson: vi.fn(),
  patchJson: vi.fn(),
  deleteReq: vi.fn(),
}))
import { getJson, postJson } from '@/lib/api'

describe('SenderSuggestions', () => {
  beforeEach(() => {
    vi.mocked(getJson).mockReset()
    vi.mocked(postJson).mockReset()
  })

  it('renders suggestions and approves one', async () => {
    vi.mocked(getJson).mockResolvedValueOnce([
      { id: 5, emailAddress: 'shop@x.com', label: null, sampleSubject: 'Your receipt', candidateCount: 3, lastSeenAt: null },
    ])
    vi.mocked(postJson).mockResolvedValue({ ok: true })
    render(<SenderSuggestions />)
    await waitFor(() => expect(screen.getByText('shop@x.com')).toBeInTheDocument())
    expect(screen.getByText(/3 emails/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /approve/i }))
    await waitFor(() => expect(postJson).toHaveBeenCalledWith('/api/email/suggestions/5/approve'))
  })

  it('shows nothing when there are no suggestions', async () => {
    vi.mocked(getJson).mockResolvedValueOnce([])
    const { container } = render(<SenderSuggestions />)
    await waitFor(() => expect(getJson).toHaveBeenCalled())
    expect(container.textContent).not.toMatch(/approve/i)
  })
})
