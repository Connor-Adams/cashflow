import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { EmailedReceiptsTile } from './EmailedReceiptsTile'

vi.mock('@/lib/api', () => ({
  getJson: vi.fn(),
}))
import { getJson } from '@/lib/api'

function mockStatus(status: Record<string, unknown>) {
  vi.mocked(getJson).mockImplementation((path: string) => {
    if (path === '/api/email/status') return Promise.resolve(status)
    return Promise.resolve([]) // gmail order count
  })
}

describe('EmailedReceiptsTile', () => {
  // Block body on purpose: a function returned from beforeEach is run as a
  // cleanup hook, and mockReset() returns the mock itself.
  beforeEach(() => {
    vi.mocked(getJson).mockReset()
  })

  it('shows a loud connect prompt when the feature is enabled but not connected', async () => {
    mockStatus({ featureEnabled: true, connected: false })
    render(
      <MemoryRouter>
        <EmailedReceiptsTile />
      </MemoryRouter>,
    )
    await waitFor(() =>
      expect(screen.getByRole('link', { name: /connect gmail/i })).toHaveAttribute('href', '/receipts'),
    )
  })

  it('renders nothing when the feature is not configured', async () => {
    mockStatus({ featureEnabled: false, connected: false })
    const { container } = render(
      <MemoryRouter>
        <EmailedReceiptsTile />
      </MemoryRouter>,
    )
    await waitFor(() => expect(getJson).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('shows a stat + view link when connected', async () => {
    mockStatus({ featureEnabled: true, connected: true, accountEmail: 'me@gmail.com' })
    render(
      <MemoryRouter>
        <EmailedReceiptsTile />
      </MemoryRouter>,
    )
    await waitFor(() =>
      expect(screen.getByRole('link', { name: /view receipts/i })).toHaveAttribute('href', '/receipts'),
    )
  })

  it('keeps the connected tile (no count) when only the receipt-count fetch fails', async () => {
    vi.mocked(getJson).mockImplementation((path: string) => {
      if (path === '/api/email/status') {
        return Promise.resolve({ featureEnabled: true, connected: true, accountEmail: 'me@gmail.com' })
      }
      return Promise.reject(new Error('HTTP 500'))
    })
    render(
      <MemoryRouter>
        <EmailedReceiptsTile />
      </MemoryRouter>,
    )
    await waitFor(() =>
      expect(screen.getByRole('link', { name: /view receipts/i })).toBeInTheDocument(),
    )
    expect(screen.getByText(/Connected as me@gmail.com\./)).toBeInTheDocument()
    expect(screen.queryByText(/receipts? imported/)).toBeNull()
  })
})
