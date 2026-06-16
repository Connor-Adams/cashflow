import React from 'react'
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { PeriodInsightBand } from './PeriodInsightBand'
import type { PeriodInsightCurrency } from '@cashflow/shared'

const base: PeriodInsightCurrency = {
  currency: 'CAD',
  netSpend: 10000,
  realCost: 6000,
  owedBack: 4000,
  owedBackBreakdown: { reimbursable: 4000, partnerShare: 0 },
  collectedThisPeriod: 0,
  receivablesOutstanding: 1200,
  rangeKind: 'calendar-month',
  baselines: [
    {
      key: 'prior-period',
      label: 'last month',
      realCost: 6500,
      realCostDeltaPct: -7.7,
      owedBack: 3000,
      owedBackDeltaPct: 33.3,
    },
    {
      key: 'typical',
      label: 'typical',
      realCost: 5350,
      realCostDeltaPct: 12.1,
      owedBack: 2000,
      owedBackDeltaPct: 100,
    },
  ],
  movers: [
    {
      category: 'Groceries',
      currentRealCost: 420,
      baselineRealCost: 320,
      deltaAbs: 100,
      deltaPct: 31.3,
      driver: { topMerchant: 'Costco', txnCount: 3 },
    },
  ],
}

describe('PeriodInsightBand', () => {
  it('renders the realCost headline and owed-back subline', () => {
    const { getByText } = render(
      <MemoryRouter>
        <PeriodInsightBand data={base} currency="CAD" />
      </MemoryRouter>,
    )
    expect(getByText(/6,000/)).toBeTruthy()
    expect(getByText(/loaned out/i)).toBeTruthy()
    expect(getByText(/4,000/)).toBeTruthy()
  })

  it('renders the receivables-outstanding note when owed to you overall', () => {
    const { getByText } = render(
      <MemoryRouter>
        <PeriodInsightBand data={base} currency="CAD" />
      </MemoryRouter>,
    )
    expect(getByText(/owed to you overall/i)).toBeTruthy()
    expect(getByText(/1,200/)).toBeTruthy()
  })

  it('renders "nothing loaned out" when owedBack is zero', () => {
    const { getByText, queryByText } = render(
      <MemoryRouter>
        <PeriodInsightBand
          data={{ ...base, owedBack: 0, receivablesOutstanding: 0 }}
          currency="CAD"
        />
      </MemoryRouter>,
    )
    expect(getByText(/nothing loaned out this period/i)).toBeTruthy()
    expect(queryByText(/owed to you overall/i)).toBeNull()
  })

  it('renders one comparison chip per available baseline', () => {
    const { container } = render(
      <MemoryRouter>
        <PeriodInsightBand data={base} currency="CAD" />
      </MemoryRouter>,
    )
    expect(
      container.querySelectorAll('[data-slot="delta-badge"]').length,
    ).toBeGreaterThanOrEqual(2)
  })

  it('renders an owed-back trend chip for baselines with a non-null owedBackDeltaPct', () => {
    const { getAllByText } = render(
      <MemoryRouter>
        <PeriodInsightBand data={base} currency="CAD" />
      </MemoryRouter>,
    )
    // Both baselines carry an owedBackDeltaPct, so a "loaned vs <label>" chip
    // appears for each — distinct from the realCost "vs <label>" chips.
    const loanedChips = getAllByText(/loaned vs/i)
    expect(loanedChips.length).toBeGreaterThanOrEqual(2)
  })

  it('does not render owed-back trend chips when owedBackDeltaPct is null', () => {
    const { queryByText } = render(
      <MemoryRouter>
        <PeriodInsightBand
          data={{
            ...base,
            baselines: [
              {
                key: 'prior-period',
                label: 'last month',
                realCost: 6500,
                realCostDeltaPct: -7.7,
                owedBack: 0,
                owedBackDeltaPct: null,
              },
            ],
          }}
          currency="CAD"
        />
      </MemoryRouter>,
    )
    expect(queryByText(/loaned vs/i)).toBeNull()
  })

  it('renders mover rows with driver text', () => {
    const { getByText } = render(
      <MemoryRouter>
        <PeriodInsightBand data={base} currency="CAD" />
      </MemoryRouter>,
    )
    expect(getByText(/Groceries/)).toBeTruthy()
    expect(getByText(/Costco/)).toBeTruthy()
    expect(getByText(/3×/)).toBeTruthy()
  })

  it('links a mover category to its filtered transactions view', () => {
    const { getByText } = render(
      <MemoryRouter>
        <PeriodInsightBand data={base} currency="CAD" />
      </MemoryRouter>,
    )
    const link = getByText('Groceries').closest('a')
    expect(link?.getAttribute('href')).toBe('/transactions?category=Groceries')
  })

  it('omits baselines that are not present', () => {
    const { queryByText } = render(
      <MemoryRouter>
        <PeriodInsightBand data={{ ...base, baselines: [] }} currency="CAD" />
      </MemoryRouter>,
    )
    expect(queryByText(/typical/i)).toBeNull()
  })

  it('does not crash with empty arrays and null delta values', () => {
    const empty: PeriodInsightCurrency = {
      ...base,
      owedBack: 0,
      owedBackBreakdown: { reimbursable: 0, partnerShare: 0 },
      receivablesOutstanding: 0,
      baselines: [],
      movers: [],
    }
    const { getByText } = render(
      <MemoryRouter>
        <PeriodInsightBand data={empty} currency="CAD" />
      </MemoryRouter>,
    )
    expect(getByText(/nothing loaned out this period/i)).toBeTruthy()
  })
})
