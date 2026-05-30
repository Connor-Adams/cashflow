/**
 * Lightweight RRULE serializer/parser covering only the constructs the
 * RecurrencePicker generates. No external rrule library dependency.
 */

export type PickerFrequency =
  | 'none'
  | 'daily'
  | 'weekly'
  | 'monthly_day'
  | 'monthly_weekday'
  | 'yearly'

export interface PickerState {
  freq: PickerFrequency
  // weekly
  weekdays?: string[] // MO, TU, WE, TH, FR, SA, SU
  // monthly_day
  byMonthDay?: number // 1–31
  // monthly_weekday
  byDayOrdinal?: '1' | '2' | '3' | '4' | '-1'
  byDayWeekday?: string // MO, TU, etc.
  // yearly
  byMonth?: number // 1–12
  yearlyMonthDay?: number // 1–31
}

const WEEKDAY_RE = /^(MO|TU|WE|TH|FR|SA|SU)$/

/**
 * Serialize a PickerState to an RRULE string.
 * Returns '' for freq === 'none'.
 */
export function serializeRrule(state: PickerState): string {
  switch (state.freq) {
    case 'none':
      return ''
    case 'daily':
      return 'FREQ=DAILY'
    case 'weekly': {
      const days = (state.weekdays ?? []).filter((d) => WEEKDAY_RE.test(d))
      if (days.length === 0) return 'FREQ=WEEKLY'
      return `FREQ=WEEKLY;BYDAY=${days.join(',')}`
    }
    case 'monthly_day': {
      const day = state.byMonthDay ?? 1
      return `FREQ=MONTHLY;BYMONTHDAY=${day}`
    }
    case 'monthly_weekday': {
      const ordinal = state.byDayOrdinal ?? '1'
      const weekday = state.byDayWeekday ?? 'MO'
      return `FREQ=MONTHLY;BYDAY=${ordinal}${weekday}`
    }
    case 'yearly': {
      const month = state.byMonth ?? 1
      const day = state.yearlyMonthDay ?? 1
      return `FREQ=YEARLY;BYMONTH=${month};BYMONTHDAY=${day}`
    }
    default:
      return ''
  }
}

/**
 * Parse an RRULE string into a PickerState.
 * Returns null if the string cannot be parsed by this picker.
 */
export function parseRrule(rrule: string): PickerState | null {
  if (!rrule.trim()) return { freq: 'none' }

  // Split into key=value pairs
  const parts: Record<string, string> = {}
  for (const segment of rrule.split(';')) {
    const eq = segment.indexOf('=')
    if (eq === -1) return null
    parts[segment.slice(0, eq).toUpperCase()] = segment.slice(eq + 1)
  }

  const freq = parts['FREQ']?.toUpperCase()
  if (!freq) return null

  if (freq === 'DAILY' && Object.keys(parts).length === 1) {
    return { freq: 'daily' }
  }

  if (freq === 'WEEKLY') {
    const byday = parts['BYDAY']
    if (!byday) return { freq: 'weekly', weekdays: [] }
    const days = byday.split(',').map((d) => d.toUpperCase())
    if (!days.every((d) => WEEKDAY_RE.test(d))) return null
    return { freq: 'weekly', weekdays: days }
  }

  if (freq === 'MONTHLY') {
    if (parts['BYMONTHDAY']) {
      const day = parseInt(parts['BYMONTHDAY'], 10)
      if (!Number.isInteger(day) || day < 1 || day > 31) return null
      return { freq: 'monthly_day', byMonthDay: day }
    }
    if (parts['BYDAY']) {
      // e.g. 2TU or -1FR
      const m = /^(-?[1-4])?(MO|TU|WE|TH|FR|SA|SU)$/.exec(parts['BYDAY'])
      if (!m) return null
      const ordinalRaw = m[1] ?? '1'
      if (!['1', '2', '3', '4', '-1'].includes(ordinalRaw)) return null
      return {
        freq: 'monthly_weekday',
        byDayOrdinal: ordinalRaw as PickerState['byDayOrdinal'],
        byDayWeekday: m[2],
      }
    }
    return null
  }

  if (freq === 'YEARLY') {
    const month = parseInt(parts['BYMONTH'] ?? '', 10)
    const day = parseInt(parts['BYMONTHDAY'] ?? '', 10)
    if (!Number.isInteger(month) || month < 1 || month > 12) return null
    if (!Number.isInteger(day) || day < 1 || day > 31) return null
    return { freq: 'yearly', byMonth: month, yearlyMonthDay: day }
  }

  return null
}

// ---------------------------------------------------------------------------
// Occurrence generator
// ---------------------------------------------------------------------------

/** Parse a YYYY-MM-DD string into a Date (local time). */
function parseDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** Format a Date as YYYY-MM-DD. */
function fmtDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

const WEEKDAY_NAMES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

/**
 * Return the nth occurrence (1-based, or -1 for last) of a weekday in a month.
 * Returns null if that slot doesn't exist in the month.
 */
function nthWeekdayOfMonth(
  year: number,
  month: number, // 1–12
  weekday: string, // MO, TU, etc.
  ordinal: number, // 1,2,3,4 or -1
): Date | null {
  const wdIndex = WEEKDAY_NAMES.indexOf(weekday)
  if (wdIndex === -1) return null

  if (ordinal === -1) {
    // Last occurrence: start from end of month
    const daysInMonth = new Date(year, month, 0).getDate()
    const d = new Date(year, month - 1, daysInMonth)
    while (d.getDay() !== wdIndex) d.setDate(d.getDate() - 1)
    return d
  }

  // Find first occurrence
  const d = new Date(year, month - 1, 1)
  while (d.getDay() !== wdIndex) d.setDate(d.getDate() + 1)
  // Advance by (ordinal - 1) weeks
  d.setDate(d.getDate() + (ordinal - 1) * 7)
  // Make sure we didn't overflow into next month
  if (d.getMonth() !== month - 1) return null
  return d
}

/**
 * Compute up to `count` future occurrences of an RRULE starting from (and
 * including) `startDate`. Returns dates as YYYY-MM-DD strings.
 */
export function computeNextOccurrences(
  rruleStr: string,
  startDate: string,
  count: number,
): string[] {
  const state = parseRrule(rruleStr)
  if (!state || state.freq === 'none') return []

  const results: string[] = []
  const start = parseDate(startDate)

  switch (state.freq) {
    case 'daily': {
      const cur = new Date(start)
      while (results.length < count) {
        results.push(fmtDate(cur))
        cur.setDate(cur.getDate() + 1)
      }
      break
    }

    case 'weekly': {
      const days = state.weekdays ?? []
      if (days.length === 0) break
      // Collect weekday indices sorted
      const wdIndices = days
        .map((d) => WEEKDAY_NAMES.indexOf(d))
        .filter((i) => i !== -1)
        .sort((a, b) => a - b)

      const cur = new Date(start)
      // Advance to start of current week (Sunday)
      const startDow = cur.getDay()
      cur.setDate(cur.getDate() - startDow)

      while (results.length < count) {
        for (const wi of wdIndices) {
          const candidate = new Date(cur)
          candidate.setDate(cur.getDate() + wi)
          if (candidate >= start && results.length < count) {
            results.push(fmtDate(candidate))
          }
        }
        cur.setDate(cur.getDate() + 7)
      }
      break
    }

    case 'monthly_day': {
      const targetDay = state.byMonthDay ?? 1
      let year = start.getFullYear()
      let month = start.getMonth() + 1 // 1-based

      while (results.length < count) {
        const daysInMonth = new Date(year, month, 0).getDate()
        if (targetDay <= daysInMonth) {
          const candidate = new Date(year, month - 1, targetDay)
          if (candidate >= start) {
            results.push(fmtDate(candidate))
          }
        }
        month++
        if (month > 12) {
          month = 1
          year++
        }
      }
      break
    }

    case 'monthly_weekday': {
      const ordinal = parseInt(state.byDayOrdinal ?? '1', 10)
      const weekday = state.byDayWeekday ?? 'MO'
      let year = start.getFullYear()
      let month = start.getMonth() + 1

      while (results.length < count) {
        const candidate = nthWeekdayOfMonth(year, month, weekday, ordinal)
        if (candidate && candidate >= start) {
          results.push(fmtDate(candidate))
        }
        month++
        if (month > 12) {
          month = 1
          year++
        }
      }
      break
    }

    case 'yearly': {
      const targetMonth = state.byMonth ?? 1
      const targetDay = state.yearlyMonthDay ?? 1
      let year = start.getFullYear()

      while (results.length < count) {
        const daysInMonth = new Date(year, targetMonth, 0).getDate()
        if (targetDay <= daysInMonth) {
          const candidate = new Date(year, targetMonth - 1, targetDay)
          if (candidate >= start) {
            results.push(fmtDate(candidate))
          }
        }
        year++
      }
      break
    }
  }

  return results.slice(0, count)
}
