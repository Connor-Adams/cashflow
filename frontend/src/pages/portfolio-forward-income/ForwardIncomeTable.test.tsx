import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ForwardIncomeTable } from './ForwardIncomeTable'
import type { PortfolioForwardIncomeRow } from '../../types/api'

function row(overrides: Partial<PortfolioForwardIncomeRow> = {}): PortfolioForwardIncomeRow {
  return {
    securityId: 1, symbol: 'VCN', name: 'Vanguard Canada', assetType: 'etf',
    currency: 'CAD', qty: 100, currentMvNative: 5000, costBasisNative: 4500,
    annualDividendPerShare: 1.2, annualInterestPerShare: 0,
    projectedAnnualIncomeNative: 120, projectedAnnualIncomeCad: 120,
    forwardYieldPct: 2.4, forwardYieldOnCostPct: 2.67,
    cadenceLabel: 'monthly', cvPct: 0.1, unreliable: false,
    nextExDivDates: [],
    ...overrides,
  }
}

describe('ForwardIncomeTable', () => {
  it('renders rows', () => {
    render(
      <MemoryRouter>
        <ForwardIncomeTable rows={[row({ symbol: 'VCN' }), row({ securityId: 2, symbol: 'XEQT', projectedAnnualIncomeCad: 200 })]} />
      </MemoryRouter>,
    )
    expect(screen.getByText('VCN')).toBeInTheDocument()
    expect(screen.getByText('XEQT')).toBeInTheDocument()
  })

  it('default sort is projectedAnnualIncomeCad desc', () => {
    render(
      <MemoryRouter>
        <ForwardIncomeTable rows={[row({ symbol: 'A', projectedAnnualIncomeCad: 50 }), row({ securityId: 2, symbol: 'B', projectedAnnualIncomeCad: 500 })]} />
      </MemoryRouter>,
    )
    const symbols = screen.getAllByTestId('fi-row-symbol').map((el) => el.textContent)
    expect(symbols).toEqual(['B', 'A'])
  })

  it('hide-unreliable filter removes flagged rows', () => {
    render(
      <MemoryRouter>
        <ForwardIncomeTable rows={[
          row({ symbol: 'A', unreliable: false }),
          row({ securityId: 2, symbol: 'B', unreliable: true }),
        ]} />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByLabelText(/hide unreliable/i))
    expect(screen.queryByText('B')).not.toBeInTheDocument()
    expect(screen.getByText('A')).toBeInTheDocument()
  })

  it('clicking symbol cell navigates to drill', () => {
    render(
      <MemoryRouter>
        <ForwardIncomeTable rows={[row({ securityId: 42, symbol: 'VCN' })]} />
      </MemoryRouter>,
    )
    const link = screen.getByRole('link', { name: 'VCN' })
    expect(link.getAttribute('href')).toBe('/portfolio/security/42')
  })
})
