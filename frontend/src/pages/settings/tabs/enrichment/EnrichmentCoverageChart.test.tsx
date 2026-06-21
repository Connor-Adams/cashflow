import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EnrichmentCoverageChart } from './EnrichmentCoverageChart'
import * as api from '../../../../lib/api'

describe('EnrichmentCoverageChart', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getJson').mockResolvedValue({
      bucket: 'month',
      series: [
        { period: '2026-04', total: 100, cleared: 80, withCanonical: 60 },
        { period: '2026-05', total: 50, cleared: 45, withCanonical: 40 },
      ],
    } as never)
  })
  it('renders the heading and notes spend date', async () => {
    render(<EnrichmentCoverageChart />)
    await waitFor(() => expect(screen.getByText(/coverage/i)).toBeInTheDocument())
    expect(screen.getByText(/spend date/i)).toBeInTheDocument()
  })
})
