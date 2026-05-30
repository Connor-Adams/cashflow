import { describe, it, expect } from 'vitest'
import {
  draftsToAssumptions,
  describeAssumption,
  type DraftAssumption,
} from './scenarioAssumptions'

function draft(overrides: Partial<DraftAssumption>): DraftAssumption {
  return {
    kind: 'income_pct',
    pct: '',
    amount: '',
    date: '',
    direction: 'out',
    ...overrides,
  }
}

describe('draftsToAssumptions', () => {
  it('converts whole-number percent input to fractional pct', () => {
    const out = draftsToAssumptions([draft({ kind: 'income_pct', pct: '-30' })])
    expect(out).toEqual([{ kind: 'income_pct', pct: -0.3 }])
  })

  it('converts expense percent input', () => {
    const out = draftsToAssumptions([draft({ kind: 'expense_pct', pct: '5' })])
    expect(out).toEqual([{ kind: 'expense_pct', pct: 0.05 }])
  })

  it('passes through savings_monthly amount', () => {
    const out = draftsToAssumptions([
      draft({ kind: 'savings_monthly', amount: '2000' }),
    ])
    expect(out).toEqual([{ kind: 'savings_monthly', amount: 2000 }])
  })

  it('builds a one_off assumption', () => {
    const out = draftsToAssumptions([
      draft({ kind: 'one_off', amount: '25000', date: '2026-07-01', direction: 'out' }),
    ])
    expect(out).toEqual([
      { kind: 'one_off', date: '2026-07-01', amount: 25000, direction: 'out' },
    ])
  })

  it('skips a percent row with a non-numeric value', () => {
    const out = draftsToAssumptions([draft({ kind: 'income_pct', pct: '' })])
    expect(out).toEqual([])
  })

  it('skips a negative savings amount', () => {
    const out = draftsToAssumptions([
      draft({ kind: 'savings_monthly', amount: '-5' }),
    ])
    expect(out).toEqual([])
  })

  it('skips a one_off missing a date', () => {
    const out = draftsToAssumptions([
      draft({ kind: 'one_off', amount: '100', date: '', direction: 'out' }),
    ])
    expect(out).toEqual([])
  })

  it('drops invalid rows but keeps valid ones', () => {
    const out = draftsToAssumptions([
      draft({ kind: 'income_pct', pct: 'abc' }),
      draft({ kind: 'expense_pct', pct: '10' }),
    ])
    expect(out).toEqual([{ kind: 'expense_pct', pct: 0.1 }])
  })
})

describe('describeAssumption', () => {
  it('describes an income change with a sign', () => {
    expect(describeAssumption({ kind: 'income_pct', pct: -0.3 }, 'CAD')).toBe(
      'Income -30%',
    )
    expect(describeAssumption({ kind: 'income_pct', pct: 0.1 }, 'CAD')).toBe(
      'Income +10%',
    )
  })

  it('describes a monthly savings assumption with money', () => {
    const text = describeAssumption({ kind: 'savings_monthly', amount: 2000 }, 'CAD')
    expect(text).toMatch(/Save .*\/ month/)
  })

  it('describes a one-off spend vs receive', () => {
    expect(
      describeAssumption(
        { kind: 'one_off', amount: 100, date: '2026-07-01', direction: 'out' },
        'CAD',
      ),
    ).toMatch(/^Spend .* on 2026-07-01$/)
    expect(
      describeAssumption(
        { kind: 'one_off', amount: 100, date: '2026-07-01', direction: 'in' },
        'CAD',
      ),
    ).toMatch(/^Receive .* on 2026-07-01$/)
  })
})
