import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { AboutCard } from './AboutCard'

const fresh = (over: Record<string, unknown> = {}) => ({
  securityId: 1, sector: 'Tech', industry: 'Software', country: 'USA',
  exchange: 'NASDAQ', description: 'A long description that should be truncated by default ...'.repeat(10),
  metadataFetchedAt: '2026-05-24T10:00:00.000Z',
  backfill: { status: 'fresh' as const, lastFetchedAt: null, nextRetryAt: null, coverageDays: 1 },
  ...over,
})

describe('AboutCard', () => {
  it('renders sector/industry/country/exchange', () => {
    const { getByText } = render(<AboutCard overview={fresh()} />)
    expect(getByText('Tech')).not.toBeNull()
    expect(getByText('Software')).not.toBeNull()
    expect(getByText('USA')).not.toBeNull()
    expect(getByText('NASDAQ')).not.toBeNull()
  })

  it('truncates long description and reveals on Show more', () => {
    const { getByText, container } = render(<AboutCard overview={fresh()} />)
    const beforeLen = container.textContent?.length ?? 0
    fireEvent.click(getByText('Show more'))
    const afterLen = container.textContent?.length ?? 0
    expect(afterLen).toBeGreaterThan(beforeLen)
  })

  it('renders placeholder when no overview', () => {
    const { getByText } = render(<AboutCard overview={null} />)
    expect(getByText(/No company info/i)).not.toBeNull()
  })
})
