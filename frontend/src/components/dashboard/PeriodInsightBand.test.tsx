import React from 'react'
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { PeriodInsightBand } from './PeriodInsightBand'
import type { PeriodInsightCurrency } from '@cashflow/shared'

const base: PeriodInsightCurrency = {
  currency: 'CAD',
  netSpend: 10000,
  realCost: 6000,
  owedBack: 4000,
  owedBackBreakdown: { reimbursable: 4000, partnerShare: 0 },
  peerLending: { lent: 0, received: 0 },
  totalSpend: 12000,
  totalCredits: 2000,
  totalIncome: 3500,
  totalPayments: 8000,
}

describe('PeriodInsightBand', () => {
  it('renders the realCost headline', () => {
    const { getByText } = render(<PeriodInsightBand data={base} currency="CAD" />)
    expect(getByText('$6,000.00')).toBeTruthy()
  })

  it('renders the four where-the-money-moved breakdown values', () => {
    const { getByText } = render(<PeriodInsightBand data={base} currency="CAD" />)
    expect(getByText('Spend')).toBeTruthy()
    expect(getByText('$12,000.00')).toBeTruthy() // totalSpend
    expect(getByText('Refunds / credits')).toBeTruthy()
    expect(getByText('$2,000.00')).toBeTruthy() // totalCredits
    expect(getByText('Income')).toBeTruthy()
    expect(getByText('$3,500.00')).toBeTruthy() // totalIncome
    expect(getByText('Payments / transfers')).toBeTruthy()
    expect(getByText('$8,000.00')).toBeTruthy() // totalPayments
  })

  it('shows the loaned-out chip when owedBack > 0', () => {
    const { getByText } = render(<PeriodInsightBand data={base} currency="CAD" />)
    expect(getByText(/loaned out/i)).toBeTruthy()
    expect(getByText(/comes back to you/i)).toBeTruthy()
    expect(getByText(/\$4,000\.00/)).toBeTruthy()
  })

  it('omits the loaned-out chip when owedBack === 0', () => {
    const { queryByText } = render(
      <PeriodInsightBand
        data={{ ...base, owedBack: 0, owedBackBreakdown: { reimbursable: 0, partnerShare: 0 } }}
        currency="CAD"
      />,
    )
    expect(queryByText(/loaned out/i)).toBeNull()
  })

  it('shows the friendly range label and currency in the caption', () => {
    const { getByText } = render(
      <PeriodInsightBand data={base} currency="CAD" rangeLabel="This month" />,
    )
    expect(getByText('This month · CAD')).toBeTruthy()
  })

  it('shows just "this period" when currency is empty', () => {
    const { getByText, queryByText } = render(
      <PeriodInsightBand data={base} currency="" />,
    )
    expect(getByText('this period')).toBeTruthy()
    expect(queryByText(/this period · /)).toBeNull()
  })

  it('shows lent-out and received-back figures when peerLending > 0', () => {
    const { getByText } = render(
      <PeriodInsightBand
        data={{ ...base, peerLending: { lent: 2500, received: 800 } }}
        currency="CAD"
      />,
    )
    expect(getByText('Lent out')).toBeTruthy()
    expect(getByText('$2,500.00')).toBeTruthy()
    expect(getByText('Received back')).toBeTruthy()
    expect(getByText('$800.00')).toBeTruthy()
  })

  it('hides lent/received figures when peerLending is zero', () => {
    const { queryByText } = render(<PeriodInsightBand data={base} currency="CAD" />)
    expect(queryByText('Lent out')).toBeNull()
    expect(queryByText('Received back')).toBeNull()
  })
})
