import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { DividendHistoryCard } from './DividendHistoryCard'
import * as api from '../../lib/api'

describe('DividendHistoryCard', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('fetches and renders dividend events', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValue({
      securityId: 1, currency: 'CAD',
      events: [
        { exDividendDate: '2026-03-15', paymentDate: '2026-04-01', recordDate: null, amount: 0.20, currency: 'CAD' },
      ],
      backfill: { status: 'fresh', lastFetchedAt: null, nextRetryAt: null, coverageDays: 1 },
    })
    const { container } = render(<DividendHistoryCard securityId={1} currency="CAD" />)
    await waitFor(() => expect(container.querySelector('svg')).not.toBeNull())
  })

  it('shows empty message when no events', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValue({
      securityId: 1, currency: 'CAD', events: [],
      backfill: { status: 'fresh', lastFetchedAt: null, nextRetryAt: null, coverageDays: 0 },
    })
    const { findByText } = render(<DividendHistoryCard securityId={1} currency="CAD" />)
    expect(await findByText(/No dividends recorded/i)).not.toBeNull()
  })
})
