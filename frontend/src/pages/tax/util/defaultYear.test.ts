import { describe, it, expect, vi } from 'vitest'
import { pickDefaultYear } from './defaultYear'

describe('pickDefaultYear', () => {
  it('uses the local calendar year, not UTC (Dec 31 evening in Toronto is already Jan 1 UTC)', () => {
    const now = new Date(2025, 11, 31, 23, 0)
    // Pin the UTC reading so the case holds whatever TZ the runner uses.
    vi.spyOn(now, 'getUTCFullYear').mockReturnValue(2026)
    expect(pickDefaultYear([2023, 2024, 2025], now)).toBe(2024)
  })

  it('falls back to the latest year when last year has no data', () => {
    expect(pickDefaultYear([2021, 2022], new Date(2025, 5, 1))).toBe(2022)
  })
})
