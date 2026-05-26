import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ByTaxStatusBreakdown } from './ByTaxStatusBreakdown'

describe('ByTaxStatusBreakdown', () => {
  it('renders bucket rows with currency + total CAD', () => {
    render(
      <ByTaxStatusBreakdown
        buckets={[
          { taxStatus: 'registered_tfsa', byCurrency: [{ currency: 'CAD', amount: 60 }, { currency: 'USD', amount: 40 }], totalCad: 114.8 },
          { taxStatus: 'non_registered', byCurrency: [{ currency: 'CAD', amount: 100 }], totalCad: 100 },
        ]}
      />,
    )
    expect(screen.getByText(/TFSA/i)).toBeInTheDocument()
    expect(screen.getByText(/Non-registered/i)).toBeInTheDocument()
    expect(screen.getByText(/\$114\.80/)).toBeInTheDocument()
  })

  it('renders empty state when no buckets', () => {
    render(<ByTaxStatusBreakdown buckets={[]} />)
    expect(screen.getByText(/no projected income/i)).toBeInTheDocument()
  })
})
