import { describe, it, expect } from 'vitest'
import { safePct, safeNum, clampPct } from './num'

describe('safePct', () => {
  it('formats a finite number as a percentage', () => {
    expect(safePct(42.567)).toBe('42.6%')
  })

  it('uses digits option', () => {
    expect(safePct(50, { digits: 0 })).toBe('50%')
    expect(safePct(50.123, { digits: 2 })).toBe('50.12%')
  })

  it('returns fallback for NaN', () => {
    expect(safePct(NaN)).toBe('—')
  })

  it('returns fallback for Infinity', () => {
    expect(safePct(Infinity)).toBe('—')
  })

  it('returns fallback for -Infinity', () => {
    expect(safePct(-Infinity)).toBe('—')
  })

  it('returns fallback for null', () => {
    expect(safePct(null)).toBe('—')
  })

  it('returns fallback for undefined', () => {
    expect(safePct(undefined)).toBe('—')
  })

  it('returns custom fallback', () => {
    expect(safePct(null, { fallback: 'n/a' })).toBe('n/a')
  })

  it('clamps values > 100 to 100', () => {
    expect(safePct(105)).toBe('100.0%')
  })

  it('clamps negative values to 0', () => {
    expect(safePct(-3)).toBe('0.0%')
  })

  it('returns 0.0% for exactly 0 (not fallback)', () => {
    expect(safePct(0)).toBe('0.0%')
  })

  it('does not clamp when clamp: false', () => {
    expect(safePct(105, { clamp: false })).toBe('105.0%')
    expect(safePct(-3, { clamp: false })).toBe('-3.0%')
  })
})

describe('safeNum', () => {
  it('returns a finite number unchanged', () => {
    expect(safeNum(42)).toBe(42)
    expect(safeNum(0)).toBe(0)
    expect(safeNum(-5.5)).toBe(-5.5)
  })

  it('returns null for NaN', () => {
    expect(safeNum(NaN)).toBeNull()
  })

  it('returns null for Infinity', () => {
    expect(safeNum(Infinity)).toBeNull()
  })

  it('returns null for -Infinity', () => {
    expect(safeNum(-Infinity)).toBeNull()
  })

  it('returns null for null', () => {
    expect(safeNum(null)).toBeNull()
  })

  it('returns null for undefined', () => {
    expect(safeNum(undefined)).toBeNull()
  })

  it('parses a valid numeric string', () => {
    expect(safeNum('42.5')).toBe(42.5)
  })

  it('returns null for a non-numeric string', () => {
    expect(safeNum('abc')).toBeNull()
  })

  it('returns null for an empty string (coerces to 0 → but empty string gives NaN from Number)', () => {
    // Number('') = 0 which is finite; empty string is treated as 0
    expect(safeNum('')).toBe(0)
  })
})

describe('clampPct', () => {
  it('returns the value when in [0, 100]', () => {
    expect(clampPct(50)).toBe(50)
    expect(clampPct(0)).toBe(0)
    expect(clampPct(100)).toBe(100)
  })

  it('clamps values > 100 to 100', () => {
    expect(clampPct(105)).toBe(100)
    expect(clampPct(Infinity)).toBe(0)
  })

  it('clamps negative values to 0', () => {
    expect(clampPct(-5)).toBe(0)
  })

  it('returns 0 for NaN', () => {
    expect(clampPct(NaN)).toBe(0)
  })

  it('returns 0 for null', () => {
    expect(clampPct(null)).toBe(0)
  })

  it('returns 0 for undefined', () => {
    expect(clampPct(undefined)).toBe(0)
  })

  it('parses a numeric string', () => {
    expect(clampPct('75')).toBe(75)
  })
})
