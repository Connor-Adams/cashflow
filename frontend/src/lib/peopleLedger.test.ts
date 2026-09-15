import { describe, it, expect } from 'vitest'
import {
  formatBalanceLabel,
  formatNetFlowLabel,
  buildOwedBreakdown,
  formatRateWindows,
  currentRateLabel,
  lastStatementDate,
  summarizeScaling,
} from './peopleLedger'

describe('formatBalanceLabel', () => {
  it('a positive balance means they owe you', () => {
    expect(formatBalanceLabel({ currency: 'CAD', lent: '3648.0000', repaid: '0.0000', balance: '3648.0000' }))
      .toBe('CAD 3,648.00 owed to you')
  })

  it('a negative balance means you owe them', () => {
    expect(formatBalanceLabel({ currency: 'CAD', lent: '3648.0000', repaid: '3904.1700', balance: '-256.1700' }))
      .toBe('CAD 256.17 you owe')
  })

  it('a zero balance is settled', () => {
    expect(formatBalanceLabel({ currency: 'CAD', lent: '40.0000', repaid: '40.0000', balance: '0.0000' }))
      .toBe('CAD 0.00 settled')
  })

  /**
   * "Settled" is a claim: it says the debt is closed. A balance that isn't a
   * number says nothing at all, and must not be laundered into that claim —
   * the same "unknown reads as zero" bug this page exists to remove.
   */
  it('a non-numeric balance is never reported as settled', () => {
    const out = formatBalanceLabel({ currency: 'CAD', balance: 'not-a-number' })
    expect(out).not.toMatch(/settled/i)
    expect(out).not.toMatch(/NaN/)
    expect(out).not.toMatch(/owed|owe/i)
    expect(out).toBe('CAD balance unknown')
  })

  it('a missing balance is never reported as settled', () => {
    for (const balance of [undefined, null, '']) {
      const out = formatBalanceLabel({
        currency: 'USD',
        balance: balance as unknown as string,
      })
      expect(out).toBe('USD balance unknown')
    }
  })
})

describe('formatNetFlowLabel', () => {
  it('net flow carries no owed or owe claim', () => {
    expect(formatNetFlowLabel({ currency: 'CAD', sent: '117506.17', received: '73871.32', net: '43634.85' }))
      .toBe('CAD 43,634.85 net out')
    expect(formatNetFlowLabel({ currency: 'CAD', sent: '0.00', received: '8425.00', net: '-8425.00' }))
      .toBe('CAD 8,425.00 net in')
  })

  /**
   * The balance and the net sit in the same table row. Grouping one and not the
   * other put `CAD 30,975.00 owed to you` directly beside `CAD 30975.00 net
   * out`, which is the drift AMOUNT_FORMAT's own doc comment says it exists to
   * prevent.
   */
  it('groups thousands the same way the balance beside it does', () => {
    const net = formatNetFlowLabel({ currency: 'CAD', sent: '0', received: '0', net: '30975.00' })
    const balance = formatBalanceLabel({ currency: 'CAD', balance: '30975.0000' })
    expect(net).toBe('CAD 30,975.00 net out')
    expect(balance).toBe('CAD 30,975.00 owed to you')
  })

  it('an unreadable net is unknown, never zero flow', () => {
    expect(formatNetFlowLabel({ currency: 'CAD', sent: '0', received: '0', net: 'nope' }))
      .toBe('CAD flow unknown')
  })
})

// ── Line-of-credit interest helpers ─────────────────────────────────────────

const w = (
  fromDate: string,
  toDate: string,
  effectiveRate: string,
  extra: Partial<{
    applicableInterest: string
    allocated: string
    scalingFactor: string
    bound: boolean
  }> = {},
) => ({
  fromDate,
  toDate,
  effectiveRate,
  applicableInterest: '10.0000',
  allocated: '10.0000',
  scalingFactor: '1.000000',
  bound: false,
  ...extra,
})

describe('buildOwedBreakdown', () => {
  const principal = [{ currency: 'CAD', lent: '6700.0000', repaid: '0.0000', balance: '6700.0000' }]

  it('keeps principal, charged and accrued apart and totals them once', () => {
    const [row] = buildOwedBreakdown({
      loanBalance: principal,
      interestCharged: [{ currency: 'CAD', lent: '174.8000', repaid: '0.0000', balance: '174.8000' }],
      interestAccrued: [{ currency: 'CAD', lent: '19.6900', repaid: '0.0000', balance: '19.6900' }],
    })
    expect(row.principal).toBe(6700)
    expect(row.charged).toBe(174.8)
    expect(row.accrued).toBe(19.69)
    expect(row.total).toBeCloseTo(6894.49, 4)
    expect(row.totalIncludesEstimate).toBe(true)
  })

  /** No interest is not zero interest. A contact with none gets no row at all. */
  it('returns nothing for a contact with no interest', () => {
    expect(buildOwedBreakdown({ loanBalance: principal, interestCharged: [], interestAccrued: [] }))
      .toEqual([])
    // An older server that does not send the fields at all must behave the same.
    expect(buildOwedBreakdown({ loanBalance: principal })).toEqual([])
    expect(buildOwedBreakdown(null)).toEqual([])
  })

  it('does not claim a total when the principal is unknown', () => {
    const [row] = buildOwedBreakdown({
      loanBalance: [],
      interestCharged: [{ currency: 'CAD', lent: '174.8000', repaid: '0.0000', balance: '174.8000' }],
    })
    expect(row.principal).toBeNull()
    // Treating the missing balance as 0 would publish an "owed" figure built
    // on a blank — the unknown-reads-as-zero bug, one column over.
    expect(row.total).toBeNull()
    expect(row.totalIncludesEstimate).toBe(false)
  })

  it('never merges currencies', () => {
    const rows = buildOwedBreakdown({
      loanBalance: principal,
      interestCharged: [
        { currency: 'CAD', lent: '174.8000', repaid: '0.0000', balance: '174.8000' },
        { currency: 'USD', lent: '12.0000', repaid: '0.0000', balance: '12.0000' },
      ],
    })
    expect(rows.map((r) => r.currency)).toEqual(['CAD', 'USD'])
    expect(rows[1].principal).toBeNull()
  })
})

describe('formatRateWindows', () => {
  it('collapses consecutive windows at one rate so a rate CHANGE is what shows', () => {
    expect(
      formatRateWindows([
        w('2025-08-04', '2025-09-03', '9.4400'),
        w('2025-09-04', '2025-09-17', '9.4400'),
        w('2025-09-18', '2025-10-29', '9.1900'),
        w('2025-10-30', '2026-09-03', '8.9400'),
      ]),
    ).toBe('9.440% to 2025-09-17 · 9.190% to 2025-10-29 · 8.940% since')
  })

  it('renders nothing when no statement has been imported', () => {
    expect(formatRateWindows([])).toBe('')
    expect(formatRateWindows(undefined)).toBe('')
  })
})

describe('currentRateLabel / lastStatementDate', () => {
  const windows = [w('2025-08-04', '2025-09-17', '9.4400'), w('2025-10-30', '2026-09-03', '8.9400')]

  it('reads the rate now in force and the day charged interest runs through', () => {
    expect(currentRateLabel(windows)).toBe('8.940%')
    expect(lastStatementDate(windows)).toBe('2026-09-03')
  })

  it('invents neither when there are no windows', () => {
    expect(currentRateLabel([])).toBeNull()
    expect(lastStatementDate(undefined)).toBeNull()
  })
})

describe('summarizeScaling', () => {
  it('counts only windows that allocated something', () => {
    const s = summarizeScaling([
      // Predates every loan: allocated nothing. Not unbound — inapplicable.
      w('2025-01-01', '2025-01-31', '9.4400', { allocated: '0.0000' }),
      w('2025-08-04', '2025-09-17', '9.4400', { scalingFactor: '0.419891', bound: true }),
      w('2025-09-18', '2025-10-29', '9.1900'),
      w('2025-10-30', '2026-09-03', '8.9400', { scalingFactor: '0.430900', bound: true }),
    ])
    expect(s).toEqual({ active: 3, bound: 2, minFactor: 0.419891, billed: 40, attributed: 30 })
  })

  /**
   * The bound only scales DOWN. When a window's printed interest does not bind,
   * its allocations sum to less than the printed figure and the difference is
   * attributed to nobody — on the real data 981.76 billed against 755.12
   * allocated, mostly from windows predating any tagged lending. The ratio alone
   * hid that, so the absolute totals are reported too.
   */
  it('reports the billed total alongside what was actually attributed', () => {
    const s = summarizeScaling([
      // Predates every loan: billed, but nobody to attribute it to.
      w('2025-01-01', '2025-01-31', '9.4400', { applicableInterest: '226.6400', allocated: '0.0000' }),
      w('2025-08-04', '2025-09-17', '9.4400', { applicableInterest: '400.0000', allocated: '400.0000', bound: true }),
      w('2025-09-18', '2025-10-29', '9.1900', { applicableInterest: '355.1200', allocated: '355.1200', bound: true }),
    ])
    expect(s?.billed).toBeCloseTo(981.76, 4)
    expect(s?.attributed).toBeCloseTo(755.12, 4)
    // The gap the page must not swallow.
    expect((s?.billed ?? 0) - (s?.attributed ?? 0)).toBeCloseTo(226.64, 4)
  })

  it('is null when nothing was allocated, so nothing is rendered', () => {
    expect(summarizeScaling([w('2025-01-01', '2025-01-31', '9.4400', { allocated: '0.0000' })]))
      .toBeNull()
    expect(summarizeScaling(undefined)).toBeNull()
  })
})
