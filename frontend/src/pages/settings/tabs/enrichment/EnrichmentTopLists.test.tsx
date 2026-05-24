import React from 'react'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect } from 'vitest'
import { EnrichmentTopLists } from './EnrichmentTopLists'
import type { EnrichmentStats } from '../../../../types/api'

const TOP_RULES: EnrichmentStats['topRules'] = [
  { ruleId: 11, pattern: 'amazon', category: 'Shopping', count: 1204 },
  { ruleId: 7, pattern: 'uber', category: 'Transport', count: 312 },
  { ruleId: 19, pattern: 'spotify', category: null, count: 89 },
]

const TOP_MERCHANTS: EnrichmentStats['topCanonicalMerchants'] = [
  { name: 'Amazon', count: 1247 },
  { name: 'Uber', count: 312 },
]

function wrap(ui: React.ReactNode) {
  return <MemoryRouter>{ui}</MemoryRouter>
}

describe('EnrichmentTopLists', () => {
  it('renders both cards with their headings', () => {
    render(wrap(<EnrichmentTopLists topRules={TOP_RULES} topMerchants={TOP_MERCHANTS} />))
    expect(screen.getByText(/top firing rules/i)).toBeInTheDocument()
    expect(screen.getByText(/top canonical merchants/i)).toBeInTheDocument()
  })

  it('renders View links on rule rows that deep-link to /rules?focus=<ruleId>', () => {
    render(wrap(<EnrichmentTopLists topRules={TOP_RULES} topMerchants={TOP_MERCHANTS} />))
    const amazonView = screen.getByRole('link', { name: /view rule for amazon/i })
    expect(amazonView).toHaveAttribute('href', '/rules?focus=11')
    const uberView = screen.getByRole('link', { name: /view rule for uber/i })
    expect(uberView).toHaveAttribute('href', '/rules?focus=7')
  })

  it('renders a "Manage rules" link in the rules card header', () => {
    render(wrap(<EnrichmentTopLists topRules={TOP_RULES} topMerchants={TOP_MERCHANTS} />))
    const manage = screen.getByRole('link', { name: /manage rules/i })
    expect(manage).toHaveAttribute('href', '/rules')
  })

  it('displays "(no category)" when category is null', () => {
    render(wrap(<EnrichmentTopLists topRules={TOP_RULES} topMerchants={TOP_MERCHANTS} />))
    expect(screen.getByText(/spotify/i)).toBeInTheDocument()
    expect(screen.getByText(/\(no category\)/i)).toBeInTheDocument()
  })

  it('renders merchants as read-only rows (no View link, no anchor)', () => {
    render(wrap(<EnrichmentTopLists topRules={TOP_RULES} topMerchants={TOP_MERCHANTS} />))
    expect(screen.getByText('Amazon')).toBeInTheDocument()
    expect(screen.getByText('1,247')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /view amazon/i })).toBeNull()
  })

  it('shows empty-state copy when both lists are empty', () => {
    render(wrap(<EnrichmentTopLists topRules={[]} topMerchants={[]} />))
    expect(screen.getByText(/no rule matches recorded yet/i)).toBeInTheDocument()
    expect(screen.getByText(/none yet\. run the backfill/i)).toBeInTheDocument()
  })

  it('limits each list to 6 rows', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      ruleId: i + 1,
      pattern: `pattern${i}`,
      category: 'Cat',
      count: 100 - i,
    }))
    const manyMerchants = Array.from({ length: 10 }, (_, i) => ({
      name: `Merchant ${i}`,
      count: 100 - i,
    }))
    render(wrap(<EnrichmentTopLists topRules={many} topMerchants={manyMerchants} />))
    expect(screen.getByText('pattern0')).toBeInTheDocument()
    expect(screen.getByText('pattern5')).toBeInTheDocument()
    expect(screen.queryByText('pattern6')).toBeNull()
  })
})
