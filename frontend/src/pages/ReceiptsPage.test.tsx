import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ReceiptsPage } from './ReceiptsPage'

// Stub child components that fetch, so this test stays focused on ReceiptsPage layout + filter.
vi.mock('@/pages/settings/sections/GmailSection', () => ({
  GmailSection: () => <div data-testid="gmail-section" />,
}))
vi.mock('@/components/receipts/GmailScanHistory', () => ({
  GmailScanHistory: () => <div data-testid="scan-history" />,
}))
vi.mock('@/components/receipts/ReceiptsList', () => ({
  ReceiptsList: ({ group }: { group: string }) => <div data-testid="receipts-list">{group}</div>,
}))
vi.mock('@/pages/AmazonPage', () => ({
  AmazonPage: ({ embedded }: { embedded?: boolean }) => (
    <div data-testid="amazon-embedded">{String(embedded)}</div>
  ),
}))

describe('ReceiptsPage', () => {
  it('renders the Gmail panel, scan history, and the all-sources list by default', () => {
    render(
      <MemoryRouter initialEntries={['/receipts']}>
        <ReceiptsPage />
      </MemoryRouter>,
    )
    expect(screen.getByRole('heading', { name: /receipts/i })).toBeInTheDocument()
    expect(screen.getByTestId('gmail-section')).toBeInTheDocument()
    expect(screen.getByTestId('scan-history')).toBeInTheDocument()
    expect(screen.getByTestId('receipts-list')).toHaveTextContent('all')
  })

  it('renders the embedded AmazonPage when ?vendor=amazon', () => {
    render(
      <MemoryRouter initialEntries={['/receipts?vendor=amazon']}>
        <ReceiptsPage />
      </MemoryRouter>,
    )
    expect(screen.getByTestId('amazon-embedded')).toHaveTextContent('true')
    expect(screen.queryByTestId('receipts-list')).not.toBeInTheDocument()
  })
})
