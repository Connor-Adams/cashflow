import { describe, it, expect } from 'vitest'
import { safePct, safeNum, clampPct } from './num'

describe('safeNum', () => {
  it('returns finite numbers as-is', () => {
    expect(safeNum(42)).toBe(42)
    expect(safeNum(0)).toBe(0)
    expect(safeNum(-5)).toBe(-5)
    expect(safeNum(3.14)).toBe(3.14)
  })

  it('returns null for NaN', () => {
    expect(safeNum(NaN)).toBeNull()
  })

  it('returns null for Infinity', () => {
    expect(safeNum(Infinity)).toBeNull()
    expect(safeNum(-Infinity)).toBeNull()
  })

  it('returns null for non-numeric values', () => {
    expect(safeNum(null)).toBeNull()
    expect(safeNum(undefined)).toBeNull()
    expect(safeNum('42')).toBeNull()
    expect(safeNum({})).toBeNull()
  })
})

describe('clampPct', () => {
  it('passes through values in [0, 100]', () => {
    expect(clampPct(0)).toBe(0)
    expect(clampPct(50)).toBe(50)
    expect(clampPct(100)).toBe(100)
  })

  it('clamps values above 100', () => {
    expect(clampPct(105)).toBe(100)
    expect(clampPct(200)).toBe(100)
  })

  it('clamps negative values to 0', () => {
    expect(clampPct(-3)).toBe(0)
    expect(clampPct(-100)).toBe(0)
  })

  it('returns 0 for non-finite inputs', () => {
    expect(clampPct(NaN)).toBe(0)
    expect(clampPct(Infinity)).toBe(0)
    expect(clampPct(-Infinity)).toBe(0)
    expect(clampPct(null)).toBe(0)
    expect(clampPct(undefined)).toBe(0)
  })
})

describe('safePct', () => {
  it('formats finite values with one decimal by default', () => {
    expect(safePct(50)).toBe('50.0%')
    expect(safePct(0)).toBe('0.0%')
    expect(safePct(100)).toBe('100.0%')
  })

  it('returns fallback (—) for NaN', () => {
    expect(safePct(NaN)).toBe('—')
  })

  it('returns fallback (—) for Infinity', () => {
    expect(safePct(Infinity)).toBe('—')
    expect(safePct(-Infinity)).toBe('—')
  })

  it('returns fallback (—) for null/undefined', () => {
    expect(safePct(null)).toBe('—')
    expect(safePct(undefined)).toBe('—')
  })

  it('clamps values > 100 to 100 by default', () => {
    expect(safePct(105)).toBe('100.0%')
  })

  it('clamps negative values to 0 by default', () => {
    expect(safePct(-3)).toBe('0.0%')
  })

  it('supports custom digits', () => {
    expect(safePct(33.333, { digits: 2 })).toBe('33.33%')
  })

  it('supports custom fallback', () => {
    expect(safePct(NaN, { fallback: 'n/a' })).toBe('n/a')
  })

  it('skips clamping when clamp: false', () => {
    expect(safePct(105, { clamp: false })).toBe('105.0%')
    expect(safePct(-3, { clamp: false })).toBe('-3.0%')
  })
})
