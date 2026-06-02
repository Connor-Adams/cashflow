import { describe, it, expect } from 'vitest'
import { fmtCurrency } from './util/format'
import { labelForTotal } from './util/labels'

// Locks the float-garbage fix: raw backend Decimal strings render as grouped
// 2dp currency, never the raw float; total keys render humanized.
describe('PersonalT1 totals formatting', () => {
  it('formats a raw Decimal string as en-CA currency', () => {
    expect(fmtCurrency('28796.51844732000000725')).toBe('$28,796.52')
  })
  it('humanizes total keys', () => {
    expect(labelForTotal('totalPayable')).toBe('Total payable')
    expect(labelForTotal('refundOrOwing')).toBe('Refund / owing')
  })
})
