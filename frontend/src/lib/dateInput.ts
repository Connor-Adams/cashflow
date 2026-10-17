/**
 * Timezone-safe helpers for `<input type="date">` round-tripping (issue #280).
 *
 * `<input type="date">` produces TZ-naive `YYYY-MM-DD` strings — they carry no
 * timezone information. To keep the round-trip stable across users in any
 * timezone, every helper here uses UTC accessors:
 *
 *   - `toDateInputValue(d)` formats `d` using `getUTCFullYear / getUTCMonth /
 *     getUTCDate`. A `Date` that represents UTC midnight of 2026-05-26 always
 *     serializes to `"2026-05-26"`, regardless of `process.env.TZ`.
 *   - `fromDateInputValue(s)` parses `s` as UTC midnight of that calendar day.
 *     `fromDateInputValue('2026-05-26').toISOString()` is
 *     `'2026-05-26T00:00:00.000Z'` everywhere.
 *   - `todayDateInputValue(now?)` snaps `now` (default `new Date()`) to the
 *     user's local calendar day, then formats it as YYYY-MM-DD. This is the
 *     correct primitive for "today" defaults — a user at 23:30 PST on May 26
 *     wants the picker labelled "2026-05-26", not "2026-05-27" (UTC).
 *
 * Backend date-range endpoints accept `YYYY-MM-DD` and interpret them as UTC
 * dates, so the contract is symmetric: the picker shows what the user picked,
 * and the server queries the same calendar day.
 */
export function toDateInputValue(date: Date): string {
  const year = String(date.getUTCFullYear()).padStart(4, '0')
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Parse a `YYYY-MM-DD` string as UTC midnight of that calendar day.
 *
 * Returns `null` for malformed input (non-zero-padded parts, out-of-range
 * month/day, non-date strings). Strict parsing avoids the silent
 * `new Date('2026-13-01')` → `2027-01-01` overflow trap.
 */
export function fromDateInputValue(value: string): Date | null {
  if (typeof value !== 'string') return null
  // Strict YYYY-MM-DD with zero-padded month/day. Anything else is rejected.
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const ms = Date.UTC(year, month - 1, day)
  const out = new Date(ms)
  // Reject e.g. 2026-02-30 which would overflow into March.
  if (
    out.getUTCFullYear() !== year ||
    out.getUTCMonth() !== month - 1 ||
    out.getUTCDate() !== day
  ) {
    return null
  }
  return out
}

/**
 * Format "today" as YYYY-MM-DD using the user's local calendar day.
 *
 * This is the correct primitive for default-range pickers — `toDateInputValue`
 * uses UTC accessors, so passing it `new Date()` directly would label "today"
 * as UTC's today, which is one day off for late-evening users in behind-UTC
 * timezones (and early-morning users in ahead-UTC timezones). This helper
 * reads the local Y/M/D and re-emits them.
 *
 * Optional `now` argument is for tests.
 */
export function todayDateInputValue(now: Date = new Date()): string {
  const year = String(now.getFullYear()).padStart(4, '0')
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Compute the `{ from, to }` strings for a "last N days" quick-range ending
 * on the user's local "today".
 *
 * Both endpoints are INCLUSIVE — backend date filters use gte/lte — so
 * `from` is today minus (days − 1), giving a window of exactly `days`
 * calendar days. Subtracting `days` would silently produce an N+1-day window
 * ("30 days" spanning 31 days).
 *
 * Optional `now` argument is for tests.
 */
export function getRelativeDateRange(
  days: number,
  now: Date = new Date()
): { from: string; to: string } {
  const to = fromDateInputValue(todayDateInputValue(now))!
  const from = new Date(to)
  from.setUTCDate(from.getUTCDate() - (days - 1))
  return { from: toDateInputValue(from), to: toDateInputValue(to) }
}

/**
 * Calendar-month range. `offset` 0 = current month, -1 = previous month.
 * `from` is the 1st; `to` is the LAST day of the (offset-adjusted) month —
 * NOT "today". Period-end `to` keeps "This year" distinct from "YTD" so the
 * FilterBar exact-match highlight doesn't collide. `Date.UTC` normalizes
 * negative/overflow months, giving automatic year rollover.
 *
 * Optional `now` argument is for tests.
 */
export function getCalendarMonthRange(
  offset: number,
  now: Date = new Date()
): { from: string; to: string } {
  const today = fromDateInputValue(todayDateInputValue(now))!
  const year = today.getUTCFullYear()
  const month = today.getUTCMonth() + offset
  const from = new Date(Date.UTC(year, month, 1))
  const to = new Date(Date.UTC(year, month + 1, 0))
  return { from: toDateInputValue(from), to: toDateInputValue(to) }
}

/**
 * Calendar-quarter range. `offset` 0 = current quarter, -1 = previous.
 * Quarters start at month 0/3/6/9; `to` is the last day of the quarter.
 *
 * Optional `now` argument is for tests.
 */
export function getCalendarQuarterRange(
  offset: number,
  now: Date = new Date()
): { from: string; to: string } {
  const today = fromDateInputValue(todayDateInputValue(now))!
  const year = today.getUTCFullYear()
  const quarterStartMonth = Math.floor(today.getUTCMonth() / 3) * 3 + offset * 3
  const from = new Date(Date.UTC(year, quarterStartMonth, 1))
  const to = new Date(Date.UTC(year, quarterStartMonth + 3, 0))
  return { from: toDateInputValue(from), to: toDateInputValue(to) }
}

/**
 * Calendar-year range. `offset` 0 = current year, -1 = previous.
 * `from` is Jan 1, `to` is Dec 31 of the (offset-adjusted) year.
 *
 * Optional `now` argument is for tests.
 */
export function getCalendarYearRange(
  offset: number,
  now: Date = new Date()
): { from: string; to: string } {
  const today = fromDateInputValue(todayDateInputValue(now))!
  const year = today.getUTCFullYear() + offset
  const from = new Date(Date.UTC(year, 0, 1))
  const to = new Date(Date.UTC(year, 11, 31))
  return { from: toDateInputValue(from), to: toDateInputValue(to) }
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Last calendar day (1–31) of the UTC month `monthIndex` (may overflow). */
function lastDayOfMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate()
}

/**
 * Previous window for a calendar-aligned range of `months` months, keeping
 * the day-of-month of `effectiveTo` when the range was clamped at today.
 */
function shiftByMonths(
  from: Date,
  to: Date,
  effectiveTo: Date,
  months: number
): { from: Date; to: Date } {
  const prevFrom = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - months, 1)
  )
  if (effectiveTo.getTime() === to.getTime()) {
    // Complete period → complete previous period (ends on its month-end).
    return {
      from: prevFrom,
      to: new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() - months + 1, 0)),
    }
  }
  const y = effectiveTo.getUTCFullYear()
  const m = effectiveTo.getUTCMonth() - months
  const day = Math.min(effectiveTo.getUTCDate(), lastDayOfMonth(y, m))
  return { from: prevFrom, to: new Date(Date.UTC(y, m, day)) }
}

/**
 * The window a period should be compared against, like-for-like.
 *
 * The selected range can end in the future ("This month" runs to the 31st),
 * but only the days up to today hold data. Comparing it against a full prior
 * window of the same day-count set 17 days of October against all of
 * Aug 31..Sep 30. So:
 *
 *   1. The current side is clamped at local today (`to` = min(to, today)).
 *   2. A calendar-aligned range (starts on the 1st, ends on a month-end —
 *      This/Last month, quarter, year) shifts back by its own number of
 *      months, keeping the day-of-month: Oct 1..Oct 17 → Sep 1..Sep 17;
 *      Mar 1..Mar 30 → Feb 1..Feb 28 (clamped to the shorter month); a
 *      complete past month compares to the complete previous month.
 *   3. Any other range shifts back by its (clamped) day-span, ending the day
 *      before it starts.
 *
 * Returns `null` when there is nothing honest to compare: a missing,
 * malformed or inverted bound, or a range that starts after today.
 *
 * This only decides the comparison window — the range the user picked (and
 * the picker shows) is unchanged.
 *
 * Optional `now` argument is for tests.
 */
export function getPreviousComparisonRange(
  dateFrom: string,
  dateTo: string,
  now: Date = new Date()
): { from: string; to: string } | null {
  const from = fromDateInputValue(dateFrom)
  const to = fromDateInputValue(dateTo)
  if (!from || !to || from > to) return null
  const today = fromDateInputValue(todayDateInputValue(now))!
  if (from > today) return null
  const effectiveTo = to > today ? today : to

  const calendarAligned =
    from.getUTCDate() === 1 &&
    to.getUTCDate() === lastDayOfMonth(to.getUTCFullYear(), to.getUTCMonth())
  if (calendarAligned) {
    const months =
      (to.getUTCFullYear() - from.getUTCFullYear()) * 12 +
      (to.getUTCMonth() - from.getUTCMonth()) +
      1
    const prev = shiftByMonths(from, to, effectiveTo, months)
    return { from: toDateInputValue(prev.from), to: toDateInputValue(prev.to) }
  }

  const spanDays = Math.round((effectiveTo.getTime() - from.getTime()) / DAY_MS) + 1
  const prevTo = new Date(from.getTime() - DAY_MS)
  const prevFrom = new Date(prevTo.getTime() - (spanDays - 1) * DAY_MS)
  return { from: toDateInputValue(prevFrom), to: toDateInputValue(prevTo) }
}
