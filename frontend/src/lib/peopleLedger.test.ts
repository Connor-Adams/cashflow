import { describe, it, expect } from 'vitest'
import { formatNetLabel } from './peopleLedger'

describe('formatNetLabel', () => {
  it('labels a positive net as owed to you', () => {
    expect(formatNetLabel({ currency: 'CAD', sent: '550.0000', received: '70.0000', net: '480.0000' }))
      .toBe('CAD 480.00 owed to you')
  })
  it('labels a negative net as you owe', () => {
    expect(formatNetLabel({ currency: 'USD', sent: '0.0000', received: '100.0000', net: '-100.0000' }))
      .toBe('USD 100.00 you owe')
  })
  it('labels a zero net as settled', () => {
    expect(formatNetLabel({ currency: 'CAD', sent: '50.0000', received: '50.0000', net: '0.0000' }))
      .toBe('CAD 0.00 settled')
  })
})
