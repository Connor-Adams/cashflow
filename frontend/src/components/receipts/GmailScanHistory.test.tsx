import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { GmailScanHistory } from './GmailScanHistory'

vi.mock('@/lib/api', () => ({
  getJson: vi.fn(),
}))
import { getJson } from '@/lib/api'

describe('GmailScanHistory', () => {
  beforeEach(() => {
    vi.mocked(getJson).mockReset()
  })

  it('renders scan rows from the history endpoint', async () => {
    vi.mocked(getJson).mockResolvedValue([
      {
        messageId: 'm1',
        subject: 'Your receipt',
        fromAddr: 'no_reply@apple.com',
        status: 'extracted',
        parser: 'apple',
        externalOrderId: 7,
        errorMessage: null,
        scannedAt: '2026-05-20T10:00:00.000Z',
      },
    ])
    render(<GmailScanHistory />)
    await waitFor(() =>
      expect(screen.getByText('Your receipt')).toBeInTheDocument(),
    )
    expect(getJson).toHaveBeenCalledWith('/api/email/history')
  })

  it('shows an empty message when there is no history', async () => {
    vi.mocked(getJson).mockResolvedValue([])
    render(<GmailScanHistory />)
    await waitFor(() =>
      expect(screen.getByText(/no scans yet/i)).toBeInTheDocument(),
    )
  })
})
