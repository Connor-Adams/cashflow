import { describe, it, expect } from 'vitest'
import {
  buildMonthGrid,
  formatMonthHeading,
  monthGridRange,
  shiftMonth,
  upcomingRange,
} from './calendarMonth'

describe('buildMonthGrid', () => {
  it('returns exactly 42 cells', () => {
    const grid = buildMonthGrid(2027, 5) // June 2027
    expect(grid).toHaveLength(42)
  })

  it('starts on the Sunday on/before the 1st of the month', () => {
    // June 2027: 1st falls on a Tuesday — Sunday before is May 30.
    const grid = buildMonthGrid(2027, 5)
    expect(grid[0].iso).toBe('2027-05-30')
    expect(grid[0].day).toBe(30)
    expect(grid[0].inMonth).toBe(false)
  })

  it('marks days within the target month with inMonth=true', () => {
    const grid = buildMonthGrid(2027, 5)
    const inMonth = grid.filter((c) => c.inMonth)
    // June has 30 days.
    expect(inMonth).toHaveLength(30)
    expect(inMonth[0].iso).toBe('2027-06-01')
    expect(inMonth[inMonth.length - 1].iso).toBe('2027-06-30')
  })

  it('marks today when it falls in the grid', () => {
    // Use injected `now` so the test is deterministic.
    const now = new Date(2027, 5, 15)
    const grid = buildMonthGrid(2027, 5, now)
    const todayCell = grid.find((c) => c.isToday)
    expect(todayCell?.iso).toBe('2027-06-15')
    expect(todayCell?.inMonth).toBe(true)
  })

  it('handles February in a leap year correctly', () => {
    // 2028 is a leap year — Feb has 29 days.
    const grid = buildMonthGrid(2028, 1)
    const inMonth = grid.filter((c) => c.inMonth)
    expect(inMonth).toHaveLength(29)
    expect(inMonth[inMonth.length - 1].iso).toBe('2028-02-29')
  })
})

describe('formatMonthHeading', () => {
  it('returns full month name + 4-digit year', () => {
    expect(formatMonthHeading(2027, 0)).toBe('January 2027')
    expect(formatMonthHeading(2027, 11)).toBe('December 2027')
  })
})

describe('shiftMonth', () => {
  it('advances forward across year boundaries', () => {
    expect(shiftMonth(2027, 11, 1)).toEqual({ year: 2028, month: 0 })
  })
  it('rolls back across year boundaries', () => {
    expect(shiftMonth(2027, 0, -1)).toEqual({ year: 2026, month: 11 })
  })
  it('supports multi-month shifts', () => {
    expect(shiftMonth(2027, 5, 18)).toEqual({ year: 2028, month: 11 })
  })
})

describe('monthGridRange', () => {
  it('returns the visible-grid date range', () => {
    const range = monthGridRange(2027, 5)
    expect(range.from).toBe('2027-05-30')
    // June 2027 grid ends on 2027-07-10 (Sat following last cell).
    expect(range.to).toBe('2027-07-10')
  })
})

describe('upcomingRange', () => {
  it('returns today + 13 days inclusive', () => {
    const now = new Date(2027, 5, 15)
    const range = upcomingRange(now)
    expect(range.from).toBe('2027-06-15')
    expect(range.to).toBe('2027-06-28')
  })
})
