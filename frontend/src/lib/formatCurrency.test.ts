import { describe, it, expect } from 'vitest'
import { formatCurrency } from './formatCurrency'

describe('formatCurrency', () => {
  it('formats CAD with $ symbol and two decimals', () => {
    expect(formatCurrency(1234.5, 'CAD')).toBe('$1,234.50')
  })

  it('formats USD with US$ prefix', () => {
    expect(formatCurrency(99.9, 'USD')).toBe('US$99.90')
  })

  it('formats zero', () => {
    expect(formatCurrency(0, 'CAD')).toBe('$0.00')
  })

  it('formats negative values', () => {
    expect(formatCurrency(-50, 'CAD')).toBe('-$50.00')
  })

  it('returns string fallback for empty currency', () => {
    expect(formatCurrency(42, '')).toBe('42')
  })

  it('returns string fallback for invalid currency code', () => {
    expect(formatCurrency(42, 'ZZ')).toBe('42')
  })

  it('normalizes lowercase currency codes', () => {
    expect(formatCurrency(10, 'cad')).toBe('$10.00')
  })

  it('handles large numbers', () => {
    expect(formatCurrency(1000000, 'CAD')).toBe('$1,000,000.00')
  })
})
