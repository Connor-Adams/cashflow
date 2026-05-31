import { describe, it, expect } from 'vitest'
import { safeNum, clampPct, safePct } from './num'

describe('safeNum', () => {
  it('returns finite numbers as-is', () => {
    expect(safeNum(42)).toBe(42)
    expect(safeNum(0)).toBe(0)
    expect(safeNum(-5)).toBe(-5)
    expect(safeNum(3.14)).toBe(3.14)
  })
  it('parses finite numeric strings', () => {
    expect(safeNum('42')).toBe(42)
    expect(safeNum('0')).toBe(0)
  })
  it('returns null for NaN', () => expect(safeNum(NaN)).toBeNull())
  it('returns null for Infinity', () => expect(safeNum(Infinity)).toBeNull())
  it('returns null for -Infinity', () => expect(safeNum(-Infinity)).toBeNull())
  it('returns null for null', () => expect(safeNum(null)).toBeNull())
  it('returns null for undefined', () => expect(safeNum(undefined)).toBeNull())
  it('returns null for non-numeric strings', () => expect(safeNum('abc')).toBeNull())
})

describe('clampPct', () => {
  it('passes through values in [0, 100]', () => {
    expect(clampPct(0)).toBe(0)
    expect(clampPct(50)).toBe(50)
    expect(clampPct(100)).toBe(100)
  })
  it('clamps values above 100', () => expect(clampPct(105)).toBe(100))
  it('clamps negative values to 0', () => expect(clampPct(-3)).toBe(0))
  it('returns 0 for NaN', () => expect(clampPct(NaN)).toBe(0))
  it('returns 0 for Infinity', () => expect(clampPct(Infinity)).toBe(0))
  it('returns 0 for -Infinity', () => expect(clampPct(-Infinity)).toBe(0))
  it('returns 0 for null', () => expect(clampPct(null)).toBe(0))
  it('returns 0 for undefined', () => expect(clampPct(undefined)).toBe(0))
})

describe('safePct', () => {
  it('formats finite values with 1 decimal by default', () => {
    expect(safePct(50)).toBe('50.0%')
    expect(safePct(0)).toBe('0.0%')
    expect(safePct(100)).toBe('100.0%')
  })
  it('respects digits option', () => expect(safePct(33.33, { digits: 0 })).toBe('33%'))
  it('returns fallback for NaN', () => expect(safePct(NaN)).toBe('—'))
  it('returns fallback for Infinity', () => expect(safePct(Infinity)).toBe('—'))
  it('returns fallback for -Infinity', () => expect(safePct(-Infinity)).toBe('—'))
  it('returns fallback for null', () => expect(safePct(null)).toBe('—'))
  it('returns fallback for undefined', () => expect(safePct(undefined)).toBe('—'))
  it('accepts custom fallback', () => expect(safePct(NaN, { fallback: 'N/A' })).toBe('N/A'))
  it('clamps values above 100 to 100%', () => expect(safePct(110)).toBe('100.0%'))
  it('clamps negative values to 0%', () => expect(safePct(-3)).toBe('0.0%'))
  it('does not clamp when clamp=false', () => expect(safePct(110, { clamp: false })).toBe('110.0%'))
})
