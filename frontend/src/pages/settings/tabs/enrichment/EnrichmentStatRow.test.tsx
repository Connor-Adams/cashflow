import React from 'react'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect } from 'vitest'
import { EnrichmentStatRow } from './EnrichmentStatRow'
import type { EnrichmentStats } from '../../../../types/api'

const STATS: EnrichmentStats = {
  total: 15247,
  reviewFlagTrue: 2341,
  reviewFlagFalse: 12906,
  reviewedTrue: 8000,
  bySource: { rules: 10368, ai: 3354, manual: 1220, '(none)': 305 },
  byConfidence: { high: 9148, medium: 3812, low: 1525, '(none)': 762 },
  byTxnType: {},
  isRecurringCount: 847,
  refundLinkedCount: 98,
  transferLinkedCount: 312,
  topCanonicalMerchants: [],
  topRules: [],
}

function wrap(ui: React.ReactNode) {
  return <MemoryRouter>{ui}</MemoryRouter>
}

describe('EnrichmentStatRow', () => {
  it('renders the warning-tinted Needs review tile when reviewFlagTrue > 0', () => {
    render(wrap(<EnrichmentStatRow stats={STATS} />))
    expect(screen.getByText(/needs review/i)).toBeInTheDocument()
    expect(screen.getByText('2,341')).toBeInTheDocument()
    const tile = screen.getByText(/needs review/i).closest('[data-slot="card"]')
    expect(tile).toHaveClass('enrichWorkflowTile')
  })

  it('shows a CTA linking to /review when reviewFlagTrue > 0', () => {
    render(wrap(<EnrichmentStatRow stats={STATS} />))
    const cta = screen.getByRole('link', { name: /open review queue/i })
    expect(cta).toHaveAttribute('href', '/review')
  })

  it('shows the raw low-confidence count in the subtitle', () => {
    render(wrap(<EnrichmentStatRow stats={STATS} />))
    expect(screen.getByText(/1,525 low-confidence overall/i)).toBeInTheDocument()
  })

  it('renders 5 dashboard stat tiles with formatted counts', () => {
    render(wrap(<EnrichmentStatRow stats={STATS} />))
    expect(screen.getByText('Total')).toBeInTheDocument()
    expect(screen.getByText('15,247')).toBeInTheDocument()
    expect(screen.getByText('Cleared')).toBeInTheDocument()
    expect(screen.getByText('12,906')).toBeInTheDocument()
    expect(screen.getByText('Recurring')).toBeInTheDocument()
    expect(screen.getByText('847')).toBeInTheDocument()
    expect(screen.getByText('Refunds linked')).toBeInTheDocument()
    expect(screen.getByText('98')).toBeInTheDocument()
    expect(screen.getByText('Transfers linked')).toBeInTheDocument()
    expect(screen.getByText('312')).toBeInTheDocument()
  })

  it('renders an "In review: 0" tile (no CTA) when the backlog is empty', () => {
    render(wrap(<EnrichmentStatRow stats={{ ...STATS, reviewFlagTrue: 0 }} />))
    expect(screen.getByText(/in review/i)).toBeInTheDocument()
    expect(screen.getByText('0')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /open review queue/i })).toBeNull()
  })
})
