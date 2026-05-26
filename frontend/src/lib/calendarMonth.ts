/**
 * Calendar grid math for the financial calendar page.
 *
 * Builds a 6×7 day grid for a given month — always 42 cells so the layout
 * doesn't reflow between months with different week-counts. Cells outside
 * the current month carry `inMonth=false`; the page styles them muted.
 *
 * Weeks start on Sunday because that's what most North-American calendars
 * use; if we later need ISO weeks we can parameterise it.
 *
 * All math is local-timezone — calendar cells represent civil days, not
 * UTC days. The caller is responsible for formatting comparison keys
 * (`YYYY-MM-DD`) consistently with how the API emits event dates (also
 * local civil-day strings, no timezone applied).
 */

export type MonthCell = {
  /** YYYY-MM-DD (local). */
  iso: string
  /** Day-of-month number to render in the cell. */
  day: number
  /** Whether the cell falls inside `month`. */
  inMonth: boolean
  /** True when the cell matches today's local date. */
  isToday: boolean
}

/** Always 6 weeks × 7 days = 42 cells. */
export type MonthGrid = MonthCell[]

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function toLocalIso(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function localToday(now: Date = new Date()): string {
  return toLocalIso(now)
}

/**
 * Build a Sunday-start 6×7 month grid for the given year/month.
 *
 * @param year   four-digit year, e.g. 2026
 * @param month  zero-based month (0=Jan..11=Dec) — matches `Date#getMonth`
 * @param now    injectable "today" for tests; defaults to system time
 */
export function buildMonthGrid(
  year: number,
  month: number,
  now: Date = new Date(),
): MonthGrid {
  const firstOfMonth = new Date(year, month, 1)
  // dow=0 for Sunday … 6 for Saturday — exactly the offset we want to
  // back up so the first row starts on Sunday.
  const leading = firstOfMonth.getDay()
  const gridStart = new Date(year, month, 1 - leading)
  const today = localToday(now)
  const cells: MonthGrid = []
  for (let i = 0; i < 42; i += 1) {
    const cellDate = new Date(
      gridStart.getFullYear(),
      gridStart.getMonth(),
      gridStart.getDate() + i,
    )
    const iso = toLocalIso(cellDate)
    cells.push({
      iso,
      day: cellDate.getDate(),
      inMonth: cellDate.getMonth() === month,
      isToday: iso === today,
    })
  }
  return cells
}

/**
 * Format a month-year heading like "June 2027".
 */
export function formatMonthHeading(year: number, month: number): string {
  const date = new Date(year, month, 1)
  return date.toLocaleString('en-US', { month: 'long', year: 'numeric' })
}

/**
 * Advance year/month by `delta` months (can be negative). Returns the
 * new (year, month) pair, normalised so month stays in 0..11.
 */
export function shiftMonth(
  year: number,
  month: number,
  delta: number,
): { year: number; month: number } {
  const d = new Date(year, month + delta, 1)
  return { year: d.getFullYear(), month: d.getMonth() }
}

/**
 * Convenience: return today's (year, month) tuple in local time.
 */
export function todayYearMonth(now: Date = new Date()): {
  year: number
  month: number
} {
  return { year: now.getFullYear(), month: now.getMonth() }
}

/**
 * Return [from, to] YYYY-MM-DD covering the rendered grid for the given
 * month (always the 42 cells worth of dates so the API call lines up
 * with what the user can see).
 */
export function monthGridRange(
  year: number,
  month: number,
): { from: string; to: string } {
  const grid = buildMonthGrid(year, month)
  return { from: grid[0].iso, to: grid[grid.length - 1].iso }
}

/**
 * For the upcoming-14-days summary card. Returns [today, today+13] as
 * an inclusive YYYY-MM-DD pair (14 days total, today being day 1).
 */
export function upcomingRange(now: Date = new Date()): {
  from: string
  to: string
} {
  const from = toLocalIso(now)
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 13)
  return { from, to: toLocalIso(end) }
}
