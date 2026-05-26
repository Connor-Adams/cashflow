import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PerformanceCaveatsBanner } from './PerformanceCaveatsBanner'

describe('PerformanceCaveatsBanner', () => {
  it('hidden when no caveats', () => {
    const { container } = render(
      <PerformanceCaveatsBanner partialDaysCount={0} missingDataReasons={[]} benchmarkSymbol="SPY" benchmarkIsPartial={false} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('shows partial-day count and lists reasons', () => {
    render(<PerformanceCaveatsBanner partialDaysCount={3} missingDataReasons={['no_price:AAPL','no_fx:USD-2024-01-01']} benchmarkSymbol="SPY" benchmarkIsPartial={false} />)
    expect(screen.getByText(/3 days/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /show details/i }))
    expect(screen.getByText(/no_price:AAPL/)).toBeInTheDocument()
  })

  it('shows benchmark partial warning', () => {
    render(<PerformanceCaveatsBanner partialDaysCount={0} missingDataReasons={[]} benchmarkSymbol="VEQT.TO" benchmarkIsPartial={true} />)
    expect(screen.getByText(/benchmark data incomplete/i)).toBeInTheDocument()
  })
})
