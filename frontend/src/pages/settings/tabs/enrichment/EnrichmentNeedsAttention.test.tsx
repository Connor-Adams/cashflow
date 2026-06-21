// EnrichmentNeedsAttention.test.tsx
import React from 'react'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect } from 'vitest'
import { EnrichmentNeedsAttention } from './EnrichmentNeedsAttention'
import type { EnrichmentStats } from '../../../../types/api'

const base: EnrichmentStats = {
  total: 100, reviewFlagTrue: 5, reviewFlagFalse: 95, reviewedTrue: 0,
  bySource: {}, byConfidence: {}, byTxnType: {},
  isRecurringCount: 0, refundLinkedCount: 0, transferLinkedCount: 0,
  topCanonicalMerchants: [], topRules: [],
  uncategorizedCount: 7, merchantsMissingCanonical: 3, deadRules: [{ ruleId: 9, pattern: 'foo', category: null }],
}

describe('EnrichmentNeedsAttention', () => {
  it('links uncategorized to the null-category filter', () => {
    render(<MemoryRouter><EnrichmentNeedsAttention stats={base} /></MemoryRouter>)
    expect(screen.getByRole('link', { name: /uncategorized/i }))
      .toHaveAttribute('href', '/transactions?category=%28none%29')
  })
  it('links missing canonical to the merchantCanonical=(none) filter', () => {
    render(<MemoryRouter><EnrichmentNeedsAttention stats={base} /></MemoryRouter>)
    expect(screen.getByRole('link', { name: /missing canonical/i }))
      .toHaveAttribute('href', '/transactions?merchantCanonical=%28none%29')
  })
  it('renders dead-rule count linking to /rules', () => {
    render(<MemoryRouter><EnrichmentNeedsAttention stats={base} /></MemoryRouter>)
    expect(screen.getByRole('link', { name: /dead rules/i })).toHaveAttribute('href', '/rules')
  })
})
