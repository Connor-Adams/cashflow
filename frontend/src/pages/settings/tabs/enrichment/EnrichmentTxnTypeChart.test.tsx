import React from 'react'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect } from 'vitest'
import { EnrichmentTxnTypeChart } from './EnrichmentTxnTypeChart'

describe('EnrichmentTxnTypeChart', () => {
  it('links each type to a filtered transactions view', () => {
    render(
      <MemoryRouter>
        <EnrichmentTxnTypeChart byTxnType={{ purchase: 10, refund: 2 }} />
      </MemoryRouter>,
    )
    const link = screen.getByLabelText('View purchase transactions')
    expect(link).toHaveAttribute('href', '/transactions?txnType=purchase')
  })

  it('renders empty state', () => {
    render(<MemoryRouter><EnrichmentTxnTypeChart byTxnType={{}} /></MemoryRouter>)
    expect(screen.getByText(/no transactions yet/i)).toBeInTheDocument()
  })
})
