import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EnrichmentTab } from './EnrichmentTab'

const STATS = {
  total: 15247,
  reviewFlagTrue: 2341,
  reviewFlagFalse: 12906,
  reviewedTrue: 8000,
  bySource: { rules: 10368, ai: 3354, manual: 1220, '(none)': 305 },
  byConfidence: { high: 9148, medium: 3812, low: 1525, '(none)': 762 },
  byTxnType: { purchase: 12000, refund: 800, transfer: 447 },
  isRecurringCount: 847,
  refundLinkedCount: 98,
  transferLinkedCount: 312,
  uncategorizedCount: 432,
  merchantsMissingCanonical: 87,
  deadRules: [],
  topCanonicalMerchants: [
    { name: 'Amazon', count: 1247 },
    { name: 'Uber', count: 312 },
  ],
  topRules: [
    { ruleId: 11, pattern: 'amazon', category: 'Shopping', count: 1204 },
    { ruleId: 7, pattern: 'uber', category: 'Transport', count: 312 },
  ],
}

const COVERAGE = { bucket: 'month', series: [] }

function mockFetch(stats: typeof STATS) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo) => {
      const url = String(input)
      if (url.includes('/api/transactions/enrichment/stats'))
        return Promise.resolve({ ok: true, json: () => Promise.resolve(stats) } as Response)
      if (url.includes('/api/transactions/enrichment/coverage'))
        return Promise.resolve({ ok: true, json: () => Promise.resolve(COVERAGE) } as Response)
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response)
    }),
  )
}

function setup() {
  return render(
    <MemoryRouter>
      <EnrichmentTab />
    </MemoryRouter>,
  )
}

describe('EnrichmentTab', () => {
  beforeEach(() => mockFetch(STATS))

  it('fetches stats and renders the Needs Review workflow tile', async () => {
    setup()
    await waitFor(() => expect(screen.getAllByText('2,341').length).toBeGreaterThan(0))
    expect(screen.getAllByText(/needs review/i).length).toBeGreaterThan(0)
    const cta = screen.getByRole('link', { name: /needs review/i })
    expect(cta).toHaveAttribute('href', '/transactions?reviewFlag=true')
  })

  it('renders the "Uncategorized" needs-attention tile', async () => {
    setup()
    await waitFor(() => expect(screen.getByText(/uncategorized/i)).toBeInTheDocument())
    expect(screen.getByText('432')).toBeInTheDocument()
  })

  it('renders the dashboard stat row alongside the workflow tile', async () => {
    setup()
    await waitFor(() => expect(screen.getByText('15,247')).toBeInTheDocument())
    expect(screen.getByText('Total')).toBeInTheDocument()
    expect(screen.getByText('Cleared')).toBeInTheDocument()
    expect(screen.getByText('12,906')).toBeInTheDocument()
  })

  it('renders chart cards including the "By type" heading', async () => {
    setup()
    await waitFor(() => expect(screen.getByText(/confidence distribution/i)).toBeInTheDocument())
    expect(screen.getByText(/by source/i)).toBeInTheDocument()
    expect(screen.getByText(/by type/i)).toBeInTheDocument()
  })

  it('renders the top rules card with View links', async () => {
    setup()
    await waitFor(() => expect(screen.getByText(/top firing rules/i)).toBeInTheDocument())
    const view = screen.getByRole('link', { name: /view rule for amazon/i })
    expect(view).toHaveAttribute('href', '/rules?focus=11')
  })

  it('renders the backfill admin card at the bottom', async () => {
    setup()
    await waitFor(() => expect(screen.getByRole('heading', { name: /backfill enrichment/i })).toBeInTheDocument())
    expect(screen.getByText(/admin action/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /run backfill/i })).toBeInTheDocument()
  })

  it('does not render the old "Enrichment maintenance" or "Enrichment dashboard" headings', async () => {
    setup()
    await waitFor(() => expect(screen.getAllByText('2,341').length).toBeGreaterThan(0))
    expect(screen.queryByRole('heading', { name: /enrichment maintenance/i })).toBeNull()
    expect(screen.queryByRole('heading', { name: /enrichment dashboard/i })).toBeNull()
  })
})
