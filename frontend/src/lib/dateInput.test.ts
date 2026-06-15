import { describe, it, expect } from 'vitest'
import {
  toDateInputValue,
  fromDateInputValue,
  todayDateInputValue,
  getRelativeDateRange,
  getCalendarMonthRange,
  getCalendarQuarterRange,
  getCalendarYearRange,
} from './dateInput'

/**
 * Timezone-safety tests for the date-input helpers (issue #280).
 *
 * Node's `TZ` env variable is read once at startup, so we can't reliably swap
 * timezones at runtime within a single test process. Instead these tests
 * exercise the absolute-UTC contract directly: a Date constructed from a UTC
 * ISO string must round-trip through the helpers without drift, regardless of
 * the process TZ. The helpers use UTC accessors internally; as long as that
 * holds, the result is invariant to local TZ.
 */
describe('toDateInputValue', () => {
  it('formats a UTC-midnight Date as YYYY-MM-DD (AC #1)', () => {
    expect(toDateInputValue(new Date('2026-05-26T00:00:00Z'))).toBe('2026-05-26')
  })

  it('formats a UTC-midnight date at year boundary', () => {
    expect(toDateInputValue(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01-01')
    expect(toDateInputValue(new Date('2025-12-31T00:00:00Z'))).toBe('2025-12-31')
  })

  it('pads single-digit months and days', () => {
    expect(toDateInputValue(new Date('2026-03-04T00:00:00Z'))).toBe('2026-03-04')
  })

  it('uses UTC accessors so a late-evening local instant in a behind-UTC TZ does not shift the date', () => {
    // 23:30 UTC on 2026-05-26 — for a user in UTC-8 this is 15:30 local on
    // the same day. The helper must report 2026-05-26 (UTC), not 2026-05-27.
    expect(toDateInputValue(new Date('2026-05-26T23:30:00Z'))).toBe('2026-05-26')
  })

  it('uses UTC accessors so an early-morning local instant in an ahead-UTC TZ does not shift the date', () => {
    // 00:30 UTC on 2026-05-26 — for a user in UTC+13 (Pacific/Auckland with DST)
    // this is 13:30 local on the same calendar day. The helper must report
    // 2026-05-26, which is what the server treats as "the picked date".
    expect(toDateInputValue(new Date('2026-05-26T00:30:00Z'))).toBe('2026-05-26')
  })
})

describe('fromDateInputValue', () => {
  it('parses YYYY-MM-DD as UTC midnight (AC #2)', () => {
    expect(fromDateInputValue('2026-05-26').toISOString()).toBe(
      '2026-05-26T00:00:00.000Z',
    )
  })

  it('parses a year-boundary date as UTC midnight', () => {
    expect(fromDateInputValue('2026-01-01').toISOString()).toBe(
      '2026-01-01T00:00:00.000Z',
    )
    expect(fromDateInputValue('2025-12-31').toISOString()).toBe(
      '2025-12-31T00:00:00.000Z',
    )
  })

  it('returns null for malformed input', () => {
    expect(fromDateInputValue('')).toBeNull()
    expect(fromDateInputValue('not-a-date')).toBeNull()
    expect(fromDateInputValue('2026-13-01')).toBeNull()
    expect(fromDateInputValue('2026-02-30')).toBeNull()
    expect(fromDateInputValue('2026-5-6')).toBeNull()
    expect(fromDateInputValue('2026/05/26')).toBeNull()
  })
})

describe('round-trip stability (AC #3)', () => {
  const samples = [
    '2026-05-26',
    '2026-01-01',
    '2025-12-31',
    '2024-02-29', // leap year
    '2026-03-08', // U.S. DST spring-forward
    '2026-11-01', // U.S. DST fall-back
  ]

  for (const s of samples) {
    it(`preserves ${s} across fromDateInputValue → toDateInputValue`, () => {
      const parsed = fromDateInputValue(s)
      expect(parsed).not.toBeNull()
      expect(toDateInputValue(parsed!)).toBe(s)
    })
  }
})

describe('todayDateInputValue', () => {
  it('snaps `now` to UTC midnight of the local calendar day so the returned string matches the user-visible "today"', () => {
    // Construct a fake "now" that is late-evening local (in any TZ) and pass it
    // through. The helper must format the local calendar day, not the UTC day.
    // We can only verify by reading the value back: it must equal the local
    // YYYY-MM-DD of `now`, not a shifted day.
    const now = new Date()
    const localY = now.getFullYear()
    const localM = String(now.getMonth() + 1).padStart(2, '0')
    const localD = String(now.getDate()).padStart(2, '0')
    expect(todayDateInputValue(now)).toBe(`${localY}-${localM}-${localD}`)
  })

  it('defaults to `new Date()` when no argument is given', () => {
    const result = todayDateInputValue()
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('round-trips through fromDateInputValue cleanly', () => {
    const s = todayDateInputValue(new Date('2026-05-26T23:30:00Z'))
    const back = fromDateInputValue(s)
    expect(back).not.toBeNull()
    expect(toDateInputValue(back!)).toBe(s)
  })
})

describe('getRelativeDateRange', () => {
  // Local-noon Dates make the local calendar day deterministic in any TZ.
  const may30 = new Date(2026, 4, 30, 12, 0, 0)

  it('a 30-day window spans exactly 30 inclusive calendar days', () => {
    // May 1 → May 30 is 30 days inclusive (the backend filters with
    // gte/lte, so both endpoints count).
    expect(getRelativeDateRange(30, may30)).toEqual({
      from: '2026-05-01',
      to: '2026-05-30',
    })
  })

  it('a 90-day window spans exactly 90 inclusive calendar days', () => {
    // Mar 2–31 (30) + April (30) + May 1–30 (30) = 90 days inclusive.
    expect(getRelativeDateRange(90, may30)).toEqual({
      from: '2026-03-02',
      to: '2026-05-30',
    })
  })

  it('crosses month and year boundaries correctly', () => {
    const jan5 = new Date(2026, 0, 5, 12, 0, 0)
    // Dec 7–31 (25) + Jan 1–5 (5) = 30 days inclusive.
    expect(getRelativeDateRange(30, jan5)).toEqual({
      from: '2025-12-07',
      to: '2026-01-05',
    })
  })

  it('days=1 returns a single-day window (from === to)', () => {
    expect(getRelativeDateRange(1, may30)).toEqual({
      from: '2026-05-30',
      to: '2026-05-30',
    })
  })

  it('defaults `now` to today and spans the requested inclusive length', () => {
    const { from, to } = getRelativeDateRange(30)
    expect(to).toBe(todayDateInputValue())
    const dayMs = 24 * 60 * 60 * 1000
    const span =
      (fromDateInputValue(to)!.getTime() - fromDateInputValue(from)!.getTime()) /
        dayMs +
      1
    expect(span).toBe(30)
  })
})

describe('getCalendarMonthRange', () => {
  const jun15 = new Date(Date.UTC(2026, 5, 15)) // 2026-06-15

  it('offset 0 = first..last day of current month', () => {
    expect(getCalendarMonthRange(0, jun15)).toEqual({
      from: '2026-06-01',
      to: '2026-06-30',
    })
  })

  it('offset -1 = previous full month', () => {
    expect(getCalendarMonthRange(-1, jun15)).toEqual({
      from: '2026-05-01',
      to: '2026-05-31',
    })
  })

  it('offset -1 in January rolls back to previous December', () => {
    const jan5 = new Date(Date.UTC(2026, 0, 5))
    expect(getCalendarMonthRange(-1, jan5)).toEqual({
      from: '2025-12-01',
      to: '2025-12-31',
    })
  })

  it('handles leap-year February end date', () => {
    const feb10 = new Date(Date.UTC(2028, 1, 10)) // 2028 is a leap year
    expect(getCalendarMonthRange(0, feb10)).toEqual({
      from: '2028-02-01',
      to: '2028-02-29',
    })
  })
})

describe('getCalendarQuarterRange', () => {
  it('offset 0 in Q2 = Apr 1..Jun 30', () => {
    const may20 = new Date(Date.UTC(2026, 4, 20))
    expect(getCalendarQuarterRange(0, may20)).toEqual({
      from: '2026-04-01',
      to: '2026-06-30',
    })
  })

  it('offset -1 in Q1 rolls back to prior-year Q4', () => {
    const feb10 = new Date(Date.UTC(2026, 1, 10))
    expect(getCalendarQuarterRange(-1, feb10)).toEqual({
      from: '2025-10-01',
      to: '2025-12-31',
    })
  })

  it('offset 0 in Q4 = Oct 1..Dec 31', () => {
    const nov3 = new Date(Date.UTC(2026, 10, 3))
    expect(getCalendarQuarterRange(0, nov3)).toEqual({
      from: '2026-10-01',
      to: '2026-12-31',
    })
  })
})

describe('getCalendarYearRange', () => {
  const jun15 = new Date(Date.UTC(2026, 5, 15))

  it('offset 0 = Jan 1..Dec 31 of current year', () => {
    expect(getCalendarYearRange(0, jun15)).toEqual({
      from: '2026-01-01',
      to: '2026-12-31',
    })
  })

  it('offset -1 = previous full year', () => {
    expect(getCalendarYearRange(-1, jun15)).toEqual({
      from: '2025-01-01',
      to: '2025-12-31',
    })
  })
})
