import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CaveatsBanner } from './CaveatsBanner'

describe('CaveatsBanner', () => {
  it('renders nothing when there are no caveats', () => {
    const { container } = render(
      <CaveatsBanner unreliableSymbols={[]} holdingsWithoutHistory={[]} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('lists unreliable symbols when expanded', () => {
    render(<CaveatsBanner unreliableSymbols={['VCN', 'XEQT']} holdingsWithoutHistory={[]} />)
    fireEvent.click(screen.getByRole('button', { name: /show details/i }))
    expect(screen.getByText('VCN')).toBeInTheDocument()
    expect(screen.getByText('XEQT')).toBeInTheDocument()
  })

  it('lists holdings without history', () => {
    render(
      <CaveatsBanner
        unreliableSymbols={[]}
        holdingsWithoutHistory={[
          { symbol: 'NEWCO', reason: 'no_dividend_history' },
        ]}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /show details/i }))
    expect(screen.getByText(/NEWCO/)).toBeInTheDocument()
    expect(screen.getByText(/no dividend history/i)).toBeInTheDocument()
  })
})
