import { describe, it, expect } from 'vitest'
import { formatMoney, formatMoneyOr } from './formatMoney'
import { formatCurrency } from './formatCurrency'

describe('formatMoney', () => {
  it('delegates to the en-CA formatCurrency path', () => {
    // AC #1: formatMoney(1234.56, 'CAD') === formatCurrency(1234.56, 'CAD')
    expect(formatMoney(1234.56, 'CAD')).toBe(formatCurrency(1234.56, 'CAD'))
    expect(formatMoney(1234.56, 'CAD')).toBe('$1,234.56')
  })

  it('renders en-CA with two fixed decimals regardless of input precision', () => {
    expect(formatMoney(1234.5, 'CAD')).toBe('$1,234.50')
    expect(formatMoney(99.9, 'USD')).toBe('US$99.90')
  })

  it('renders a real zero as $0.00', () => {
    expect(formatMoney(0, 'CAD')).toBe('$0.00')
  })

  it('falls back to String(amount) for empty/invalid currency', () => {
    expect(formatMoney(42, '')).toBe('42')
    expect(formatMoney(42, 'ZZ')).toBe('42')
  })
})

describe('formatMoneyOr', () => {
  it('returns the placeholder for null', () => {
    expect(formatMoneyOr(null, 'CAD')).toBe('—')
  })

  it('returns the placeholder for undefined', () => {
    expect(formatMoneyOr(undefined, 'CAD')).toBe('—')
  })

  it('returns the placeholder for NaN', () => {
    expect(formatMoneyOr(Number.NaN, 'CAD')).toBe('—')
  })

  it('renders a real zero as $0.00, not the placeholder', () => {
    // AC #5 / #12: genuine zero is preserved
    expect(formatMoneyOr(0, 'CAD')).toBe('$0.00')
  })

  it('renders a real value via the en-CA formatter', () => {
    expect(formatMoneyOr(1234.56, 'CAD')).toBe('$1,234.56')
  })

  it('accepts a custom placeholder', () => {
    expect(formatMoneyOr(null, 'CAD', 'n/a')).toBe('n/a')
  })
})
