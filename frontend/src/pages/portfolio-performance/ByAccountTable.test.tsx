import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { ByAccountTable } from './ByAccountTable'

describe('ByAccountTable', () => {
  it('renders empty state', () => {
    render(<ByAccountTable rows={[]} />)
    expect(screen.getByText(/no per-account/i)).toBeInTheDocument()
  })

  it('default sort: end-value desc', () => {
    render(<ByAccountTable rows={[
      { accountId: 1, accountName: 'TFSA', twrPct: 5, endValueCad: 1000, weightInPortfolioPct: 50 },
      { accountId: 2, accountName: 'RRSP', twrPct: 7, endValueCad: 2000, weightInPortfolioPct: 50 },
    ]} />)
    const rows = screen.getAllByTestId('byacct-row')
    expect(within(rows[0]).getByText('RRSP')).toBeInTheDocument()
    expect(within(rows[1]).getByText('TFSA')).toBeInTheDocument()
  })
})
