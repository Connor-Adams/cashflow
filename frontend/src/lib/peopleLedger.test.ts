import { describe, it, expect } from 'vitest'
import { formatBalanceLabel, formatNetFlowLabel } from './peopleLedger'

describe('formatBalanceLabel', () => {
  it('a positive balance means they owe you', () => {
    expect(formatBalanceLabel({ currency: 'CAD', lent: '3648.0000', repaid: '0.0000', balance: '3648.0000' }))
      .toBe('CAD 3648.00 owed to you')
  })

  it('a negative balance means you owe them', () => {
    expect(formatBalanceLabel({ currency: 'CAD', lent: '3648.0000', repaid: '3904.1700', balance: '-256.1700' }))
      .toBe('CAD 256.17 you owe')
  })

  it('a zero balance is settled', () => {
    expect(formatBalanceLabel({ currency: 'CAD', lent: '40.0000', repaid: '40.0000', balance: '0.0000' }))
      .toBe('CAD 0.00 settled')
  })
})

describe('formatNetFlowLabel', () => {
  it('net flow carries no owed or owe claim', () => {
    expect(formatNetFlowLabel({ currency: 'CAD', sent: '117506.17', received: '73871.32', net: '43634.85' }))
      .toBe('CAD 43634.85 net out')
    expect(formatNetFlowLabel({ currency: 'CAD', sent: '0.00', received: '8425.00', net: '-8425.00' }))
      .toBe('CAD 8425.00 net in')
  })
})
