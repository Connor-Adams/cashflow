import { describe, it, expect } from 'vitest'
import { TOTALS_LABELS, humanizeKey, labelForTotal } from './labels'

describe('tax total labels', () => {
  it('maps known total keys to human labels', () => {
    expect(labelForTotal('totalPayable')).toBe('Total payable')
    expect(labelForTotal('refundOrOwing')).toBe('Refund / owing')
    expect(labelForTotal('netTaxPayable')).toBe('Net tax payable')
    expect(TOTALS_LABELS.eiPremium).toBe('EI premiums')
  })

  it('humanizes unknown camelCase keys as a fallback', () => {
    expect(labelForTotal('smallBusinessDeduction')).toBe('Small business deduction')
    expect(humanizeKey('grossTaxBeforeCredits')).toBe('Gross tax before credits')
  })

  it('handles single-word and acronym-ish keys', () => {
    expect(humanizeKey('income')).toBe('Income')
  })
})
