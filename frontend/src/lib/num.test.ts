import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { safePct, safeNum, clampPct } from './num.js'

describe('safePct', () => {
  it('finite value formats with 1 decimal by default', () => {
    assert.equal(safePct(50), '50.0%')
  })
  it('NaN returns fallback', () => {
    assert.equal(safePct(NaN), '—')
  })
  it('Infinity returns fallback', () => {
    assert.equal(safePct(Infinity), '—')
  })
  it('-Infinity returns fallback', () => {
    assert.equal(safePct(-Infinity), '—')
  })
  it('null returns fallback', () => {
    assert.equal(safePct(null), '—')
  })
  it('undefined returns fallback', () => {
    assert.equal(safePct(undefined), '—')
  })
  it('negative value clamps to 0.0%', () => {
    assert.equal(safePct(-3), '0.0%')
  })
  it('value > 100 clamps to 100.0%', () => {
    assert.equal(safePct(105), '100.0%')
  })
  it('zero renders as 0.0% not fallback', () => {
    assert.equal(safePct(0), '0.0%')
  })
  it('custom fallback', () => {
    assert.equal(safePct(NaN, { fallback: 'n/a' }), 'n/a')
  })
  it('custom digits', () => {
    assert.equal(safePct(50.123, { digits: 2 }), '50.12%')
  })
  it('clamp: false disables clamping', () => {
    assert.equal(safePct(105, { clamp: false }), '105.0%')
  })
})

describe('safeNum', () => {
  it('finite number returns itself', () => {
    assert.equal(safeNum(42), 42)
  })
  it('NaN returns null', () => {
    assert.equal(safeNum(NaN), null)
  })
  it('Infinity returns null', () => {
    assert.equal(safeNum(Infinity), null)
  })
  it('-Infinity returns null', () => {
    assert.equal(safeNum(-Infinity), null)
  })
  it('null returns null', () => {
    assert.equal(safeNum(null), null)
  })
  it('undefined returns null', () => {
    assert.equal(safeNum(undefined), null)
  })
  it('string returns null', () => {
    assert.equal(safeNum('42'), null)
  })
  it('zero returns 0', () => {
    assert.equal(safeNum(0), 0)
  })
  it('negative finite returns itself', () => {
    assert.equal(safeNum(-5), -5)
  })
})

describe('clampPct', () => {
  it('finite value in range returns unchanged', () => {
    assert.equal(clampPct(50), 50)
  })
  it('NaN returns 0', () => {
    assert.equal(clampPct(NaN), 0)
  })
  it('Infinity returns 0', () => {
    assert.equal(clampPct(Infinity), 0)
  })
  it('-Infinity returns 0', () => {
    assert.equal(clampPct(-Infinity), 0)
  })
  it('null returns 0', () => {
    assert.equal(clampPct(null), 0)
  })
  it('undefined returns 0', () => {
    assert.equal(clampPct(undefined), 0)
  })
  it('negative clamps to 0', () => {
    assert.equal(clampPct(-3), 0)
  })
  it('> 100 clamps to 100', () => {
    assert.equal(clampPct(105), 100)
  })
  it('zero returns 0', () => {
    assert.equal(clampPct(0), 0)
  })
})
