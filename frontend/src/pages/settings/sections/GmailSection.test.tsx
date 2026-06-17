import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { GmailSection } from './GmailSection'

vi.stubGlobal('fetch', vi.fn(() =>
  Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response),
))

describe('GmailSection', () => {
  it('renders the Connect Gmail heading', () => {
    render(<GmailSection />)
    expect(screen.getByRole('heading', { name: /connect gmail/i })).toBeInTheDocument()
  })

  it('shows a Reconnect prompt when the Google grant is revoked (status reconnect_needed)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve(
              String(url).includes('/api/email/status')
                ? {
                    connected: true,
                    featureEnabled: true,
                    accountEmail: 'ceeman@example.com',
                    status: 'reconnect_needed',
                    statusReason: 'Google access was revoked or expired.',
                  }
                : {},
            ),
        } as Response),
      ),
    )

    render(<GmailSection />)

    expect(await screen.findByRole('button', { name: /reconnect gmail/i })).toBeInTheDocument()
    expect(screen.getByText(/revoked or expired/i)).toBeInTheDocument()
  })
})
