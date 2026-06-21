import { describe, it, expect } from 'vitest'
import { formatRatePct, payoffVsInvestSentence } from './surplusCopy'
import type { SurplusPayoffVsInvest } from '@/types/api'

function pvi(over: Partial<SurplusPayoffVsInvest> = {}): SurplusPayoffVsInvest {
  return {
    interestSaved: 300,
    investGain: 800,
    assumedAnnualReturnRate: 0.05,
    horizonYears: 10,
    recommendation: 'invest',
    ...over,
  }
}

describe('formatRatePct', () => {
  it('formats whole percents without decimals', () => {
    expect(formatRatePct(0.05)).toBe('5%')
  })
  it('formats fractional percents', () => {
    expect(formatRatePct(0.075)).toBe('7.5%')
  })
})

describe('payoffVsInvestSentence', () => {
  it('leads with interest saved when payoff wins', () => {
    const s = payoffVsInvestSentence(
      pvi({ recommendation: 'payoff', interestSaved: 900, investGain: 400 }),
      'CAD',
    )
    expect(s).toMatch(/^Paying down debt saves ~/)
    expect(s).toContain('in interest')
    expect(s).toContain('more than')
  })

  it('leads with projected growth when invest wins', () => {
    const s = payoffVsInvestSentence(
      pvi({ recommendation: 'invest', interestSaved: 200, investGain: 900 }),
      'CAD',
    )
    expect(s).toMatch(/^Invested at 5%, this surplus could grow ~/)
    expect(s).toContain('vs. ~')
  })

  it('uses neutral phrasing on a tie', () => {
    const s = payoffVsInvestSentence(
      pvi({ recommendation: 'tie', interestSaved: 0, investGain: 0 }),
      'CAD',
    )
    expect(s).toContain('about the same')
  })

  it('renders the horizon and rate', () => {
    const s = payoffVsInvestSentence(
      pvi({ assumedAnnualReturnRate: 0.07, horizonYears: 15, recommendation: 'invest' }),
      'CAD',
    )
    expect(s).toContain('7%')
    expect(s).toContain('15 years')
  })
})
