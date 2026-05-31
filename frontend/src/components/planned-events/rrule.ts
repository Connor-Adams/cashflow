/**
 * Minimal RRULE serializer + parser covering exactly the constructs the
 * RecurrencePicker generates. Exotic rules (BYHOUR, BYSETPOS, EXDATE, etc.)
 * are left to the "advanced" text input.
 */

export type Freq = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'

export const WEEKDAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const
export type WeekdayCode = (typeof WEEKDAY_CODES)[number]

export const WEEKDAY_LABELS: Record<WeekdayCode, string> = {
  MO: 'M', TU: 'T', WE: 'W', TH: 'T', FR: 'F', SA: 'S', SU: 'S',
}
export const WEEKDAY_ARIA: Record<WeekdayCode, string> = {
  MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday', TH: 'Thursday',
  FR: 'Friday', SA: 'Saturday', SU: 'Sunday',
}

export type MonthlyMode = 'bymonthday' | 'byweekday'

export interface PickerState {
  freq: Freq | 'NONE'
  /** Weekly: which days are selected */
  byDay: WeekdayCode[]
  /** Monthly bymonthday: 1–31 */
  byMonthDay: number
  /** Monthly byweekday: ordinal (1–4 or -1 for Last) */
  weekdayOrdinal: 1 | 2 | 3 | 4 | -1
  /** Monthly byweekday: which weekday */
  weekdayCode: WeekdayCode
  monthlyMode: MonthlyMode
  /** Yearly: month 1–12 */
  byMonth: number
  /** Yearly: day 1–31 */
  byYearDay: number
}

export function defaultState(): PickerState {
  return {
    freq: 'NONE',
    byDay: [],
    byMonthDay: 1,
    weekdayOrdinal: 1,
    weekdayCode: 'MO',
    monthlyMode: 'bymonthday',
    byMonth: 1,
    byYearDay: 1,
  }
}

/** Serialize picker state to RRULE string (or '' for NONE) */
export function serialize(s: PickerState): string {
  if (s.freq === 'NONE') return ''
  if (s.freq === 'DAILY') return 'FREQ=DAILY'
  if (s.freq === 'WEEKLY') {
    if (s.byDay.length === 0) return 'FREQ=WEEKLY'
    return `FREQ=WEEKLY;BYDAY=${s.byDay.join(',')}`
  }
  if (s.freq === 'MONTHLY') {
    if (s.monthlyMode === 'bymonthday') {
      return `FREQ=MONTHLY;BYMONTHDAY=${s.byMonthDay}`
    }
    const ord = s.weekdayOrdinal === -1 ? '-1' : String(s.weekdayOrdinal)
    return `FREQ=MONTHLY;BYDAY=${ord}${s.weekdayCode}`
  }
  if (s.freq === 'YEARLY') {
    return `FREQ=YEARLY;BYMONTH=${s.byMonth};BYMONTHDAY=${s.byYearDay}`
  }
  return ''
}

type ParseResult =
  | { kind: 'picker'; state: PickerState }
  | { kind: 'advanced'; raw: string }
  | { kind: 'empty' }

/** Parse an RRULE string into picker state, falling back to 'advanced' for unsupported rules. */
export function parse(raw: string): ParseResult {
  const r = raw.trim()
  if (!r) return { kind: 'empty' }

  // Strip optional RRULE: prefix
  const ruleStr = r.startsWith('RRULE:') ? r.slice(6) : r

  const parts: Record<string, string> = {}
  for (const seg of ruleStr.split(';')) {
    const eq = seg.indexOf('=')
    if (eq === -1) continue
    parts[seg.slice(0, eq).toUpperCase()] = seg.slice(eq + 1)
  }

  const freq = parts['FREQ']
  if (!freq) return { kind: 'advanced', raw: r }

  const state = defaultState()

  if (freq === 'DAILY') {
    state.freq = 'DAILY'
    return { kind: 'picker', state }
  }

  if (freq === 'WEEKLY') {
    state.freq = 'WEEKLY'
    const byday = parts['BYDAY']
    if (byday) {
      const codes = byday.split(',').filter((c): c is WeekdayCode =>
        (WEEKDAY_CODES as readonly string[]).includes(c),
      )
      state.byDay = codes
    }
    return { kind: 'picker', state }
  }

  if (freq === 'MONTHLY') {
    state.freq = 'MONTHLY'
    const bmd = parts['BYMONTHDAY']
    const bday = parts['BYDAY']
    if (bmd) {
      const n = parseInt(bmd, 10)
      if (!Number.isFinite(n) || n < 1 || n > 31) return { kind: 'advanced', raw: r }
      state.byMonthDay = n
      state.monthlyMode = 'bymonthday'
      return { kind: 'picker', state }
    }
    if (bday) {
      const m = /^(-?\d+)(MO|TU|WE|TH|FR|SA|SU)$/.exec(bday)
      if (!m) return { kind: 'advanced', raw: r }
      const ord = parseInt(m[1], 10)
      if (ord !== 1 && ord !== 2 && ord !== 3 && ord !== 4 && ord !== -1)
        return { kind: 'advanced', raw: r }
      state.monthlyMode = 'byweekday'
      state.weekdayOrdinal = ord as 1 | 2 | 3 | 4 | -1
      state.weekdayCode = m[2] as WeekdayCode
      return { kind: 'picker', state }
    }
    return { kind: 'advanced', raw: r }
  }

  if (freq === 'YEARLY') {
    state.freq = 'YEARLY'
    const bm = parts['BYMONTH']
    const bmd = parts['BYMONTHDAY']
    if (!bm || !bmd) return { kind: 'advanced', raw: r }
    const month = parseInt(bm, 10)
    const day = parseInt(bmd, 10)
    if (!Number.isFinite(month) || !Number.isFinite(day)) return { kind: 'advanced', raw: r }
    state.byMonth = month
    state.byYearDay = day
    return { kind: 'picker', state }
  }

  return { kind: 'advanced', raw: r }
}

/** Compute the next N occurrence dates from `fromDate` (YYYY-MM-DD) given a serialized RRULE */
export function nextOccurrences(rrule: string, fromDate: string, count: number): string[] {
  if (!rrule || !fromDate) return []
  const parsed = parse(rrule)
  if (parsed.kind !== 'picker' || parsed.state.freq === 'NONE') return []
  const s = parsed.state

  const baseDate = new Date(fromDate + 'T00:00:00')
  if (isNaN(baseDate.getTime())) return []

  const results: string[] = []
  let cur = new Date(baseDate)

  const fmt = (d: Date) => d.toISOString().slice(0, 10)
  const advance = (d: Date) => {
    const next = new Date(d)
    next.setDate(next.getDate() + 1)
    return next
  }

  const matchesRule = (d: Date): boolean => {
    if (s.freq === 'DAILY') return true
    if (s.freq === 'WEEKLY') {
      const wdMap: Record<number, WeekdayCode> = {
        0: 'SU', 1: 'MO', 2: 'TU', 3: 'WE', 4: 'TH', 5: 'FR', 6: 'SA',
      }
      const wd = wdMap[d.getDay()]
      return s.byDay.length === 0 || s.byDay.includes(wd)
    }
    if (s.freq === 'MONTHLY') {
      if (s.monthlyMode === 'bymonthday') {
        return d.getDate() === s.byMonthDay
      }
      // byweekday: check ordinal and weekday
      const wdMap: Record<number, WeekdayCode> = {
        0: 'SU', 1: 'MO', 2: 'TU', 3: 'WE', 4: 'TH', 5: 'FR', 6: 'SA',
      }
      if (wdMap[d.getDay()] !== s.weekdayCode) return false
      if (s.weekdayOrdinal === -1) {
        const next = new Date(d.getFullYear(), d.getMonth() + 1, 0)
        const daysLeft = next.getDate() - d.getDate()
        return daysLeft < 7
      }
      const ordinal = Math.ceil(d.getDate() / 7)
      return ordinal === s.weekdayOrdinal
    }
    if (s.freq === 'YEARLY') {
      return d.getMonth() + 1 === s.byMonth && d.getDate() === s.byYearDay
    }
    return false
  }

  let safety = 0
  while (results.length < count && safety < 5000) {
    safety++
    if (matchesRule(cur)) {
      results.push(fmt(cur))
    }
    if (results.length < count) {
      cur = advance(cur)
    }
  }
  return results
}
