import { describe, it, expect } from 'vitest'
import { businessIncomeSpend, type BusinessIncomeSpendRow } from './businessIncomeSpend'

const r = (o: Partial<BusinessIncomeSpendRow>): BusinessIncomeSpendRow => ({
  currency: 'CAD',
  business: false,
  totalSpend: 0,
  totalCredits: 0,
  netSpend: 0,
  income: 0,
  ...o,
})

describe('businessIncomeSpend', () => {
  it('splits income and spend by business flag', () => {
    const out = businessIncomeSpend(
      [
        r({ business: true, netSpend: 3100, income: 8200 }),
        r({ business: false, netSpend: 4800, income: 5400 }),
      ],
      'CAD',
    )
    expect(out.income).toEqual({ business: 8200, personal: 5400 })
    expect(out.spend).toEqual({ business: 3100, personal: 4800 })
    expect(Math.round(out.incomeShare)).toBe(60)
    expect(Math.round(out.spendShare)).toBe(39)
  })

  it('filters by currency', () => {
    const out = businessIncomeSpend(
      [
        r({ currency: 'CAD', business: true, netSpend: 100, income: 0 }),
        r({ currency: 'USD', business: true, netSpend: 999, income: 0 }),
      ],
      'CAD',
    )
    expect(out.spend.business).toBe(100)
  })

  it('clamps share to 0 when business spend is negative', () => {
    const out = businessIncomeSpend(
      [
        r({ business: true, netSpend: -30 }),
        r({ business: false, netSpend: 100 }),
      ],
      'CAD',
    )
    expect(out.spendShare).toBe(0)
  })

  it('returns zero shares for empty input', () => {
    const out = businessIncomeSpend([], 'CAD')
    expect(out.income).toEqual({ business: 0, personal: 0 })
    expect(out.spend).toEqual({ business: 0, personal: 0 })
    expect(out.incomeShare).toBe(0)
    expect(out.spendShare).toBe(0)
  })
})
