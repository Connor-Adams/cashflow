import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildForecastQueryString, FORECAST_RANGE_DAYS } from './useForecast'
import { fromDateInputValue, todayDateInputValue } from '@/lib/dateInput'

/**
 * Clock-dependent tests fake only `Date` (not timers) so testing-library /
 * promise plumbing keeps working. The instant is chosen so UTC's calendar day
 * (2026-06-16) differs from the local day in any behind-UTC timezone
 * (2026-06-15 in UTC-4): if dateFrom were derived from
 * `toISOString().slice(0, 10)` instead of the local-day primitive, the
 * assertion would fail for behind-UTC users (issue #280 failure mode).
 */
const EVENING_UTC_INSTANT = new Date('2026-06-16T03:30:00Z')

function param(qs: string, key: string): string {
  const value = new URLSearchParams(qs.slice(1)).get(key)
  if (value == null) throw new Error(`missing ${key} in ${qs}`)
  return value
}

describe('buildForecastQueryString', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: EVENING_UTC_INSTANT, toFake: ['Date'] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("starts the window on the user's local today, not UTC's today", () => {
    const qs = buildForecastQueryString({ range: '7d' })
    expect(param(qs, 'dateFrom')).toBe(todayDateInputValue())
  })

  it.each(['7d', '30d', '90d'] as const)(
    'spans exactly %s of the inclusive backend window',
    (range) => {
      // The backend treats [dateFrom, dateTo] as inclusive on both ends
      // (backend/src/forecast/buildForecast.ts), so an N-day preset must set
      // dateTo = dateFrom + (N - 1) days. dateFrom + N would aggregate N+1
      // days of events under an "N days" label.
      const qs = buildForecastQueryString({ range })
      const from = fromDateInputValue(param(qs, 'dateFrom'))!
      const to = fromDateInputValue(param(qs, 'dateTo'))!
      const dayMs = 24 * 60 * 60 * 1000
      const inclusiveDays = (to.getTime() - from.getTime()) / dayMs + 1
      expect(inclusiveDays).toBe(FORECAST_RANGE_DAYS[range])
    },
  )
})
