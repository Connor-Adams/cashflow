/** Lightweight RRULE serializer + parser scoped to the picker's supported constructs. */

export type RRuleFreq = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'

export type RRuleDay = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU'

export interface RRuleState {
  freq: RRuleFreq | null
  /** WEEKLY: selected weekdays */
  byDay?: RRuleDay[]
  /** MONTHLY by day of month */
  byMonthDay?: number
  /** MONTHLY by Nth weekday: e.g. "1MO" = first Monday, "-1FR" = last Friday */
  byDayNth?: { n: number; day: RRuleDay }
  /** YEARLY: month (1-12) */
  byMonth?: number
  /** YEARLY: day of month */
  byYearMonthDay?: number
}

const DAY_NAMES: RRuleDay[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']

export const WEEKDAY_JS: Record<RRuleDay, number> = {
  SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6,
}

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

export const ORDINALS = ['1st', '2nd', '3rd', '4th', 'Last']

/** Serialize an RRuleState to a RRULE string (or '' if no frequency). */
export function serializeRRule(state: RRuleState): string {
  if (!state.freq) return ''
  const parts: string[] = [`FREQ=${state.freq}`]
  if (state.freq === 'WEEKLY' && state.byDay && state.byDay.length > 0) {
    parts.push(`BYDAY=${state.byDay.join(',')}`)
  }
  if (state.freq === 'MONTHLY') {
    if (state.byDayNth) {
      const { n, day } = state.byDayNth
      const prefix = n === -1 ? '-1' : String(n)
      parts.push(`BYDAY=${prefix}${day}`)
    } else if (state.byMonthDay != null) {
      parts.push(`BYMONTHDAY=${state.byMonthDay}`)
    }
  }
  if (state.freq === 'YEARLY') {
    if (state.byMonth != null) parts.push(`BYMONTH=${state.byMonth}`)
    if (state.byYearMonthDay != null) parts.push(`BYMONTHDAY=${state.byYearMonthDay}`)
  }
  return `RRULE:${parts.join(';')}`
}

/** Parse a RRULE string into an RRuleState. Returns null if the string cannot be modelled by the picker. */
export function parseRRule(raw: string): RRuleState | null {
  const src = raw.replace(/^RRULE:/i, '').trim()
  if (!src) return { freq: null }

  const params: Record<string, string> = {}
  for (const part of src.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1)
  }

  const freq = params['FREQ']?.toUpperCase() as RRuleFreq | undefined
  if (!freq || !(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as string[]).includes(freq)) {
    return null
  }

  const state: RRuleState = { freq }

  if (freq === 'WEEKLY') {
    if (params['BYDAY']) {
      const days = params['BYDAY'].split(',').map((d) => d.toUpperCase() as RRuleDay)
      if (!days.every((d) => DAY_NAMES.includes(d))) return null
      state.byDay = days
    } else {
      state.byDay = []
    }
  }

  if (freq === 'MONTHLY') {
    if (params['BYDAY']) {
      const m = /^(-?[1-4]|last)(MO|TU|WE|TH|FR|SA|SU)$/i.exec(params['BYDAY'])
      if (!m) return null
      const n = m[1].toLowerCase() === 'last' ? -1 : parseInt(m[1], 10)
      if (!Number.isInteger(n) || n === 0 || n > 4 || n < -1) return null
      state.byDayNth = { n, day: m[2].toUpperCase() as RRuleDay }
    } else if (params['BYMONTHDAY']) {
      const d = parseInt(params['BYMONTHDAY'], 10)
      if (!Number.isInteger(d) || d < 1 || d > 31) return null
      state.byMonthDay = d
    }
  }

  if (freq === 'YEARLY') {
    if (params['BYMONTH']) {
      const m = parseInt(params['BYMONTH'], 10)
      if (!Number.isInteger(m) || m < 1 || m > 12) return null
      state.byMonth = m
    }
    if (params['BYMONTHDAY']) {
      const d = parseInt(params['BYMONTHDAY'], 10)
      if (!Number.isInteger(d) || d < 1 || d > 31) return null
      state.byYearMonthDay = d
    }
    if (!params['BYMONTH'] && !params['BYMONTHDAY']) {
      // Plain YEARLY with no details — unsupported
      return null
    }
  }

  // Reject any unrecognised params (exotic rules)
  const knownParams = new Set(['FREQ', 'BYDAY', 'BYMONTHDAY', 'BYMONTH'])
  for (const k of Object.keys(params)) {
    if (!knownParams.has(k)) return null
  }

  return state
}

/** Compute up to `count` next occurrences from `startDate` (ISO YYYY-MM-DD). */
export function nextOccurrences(state: RRuleState, startDateIso: string, count = 3): string[] {
  if (!state.freq || !startDateIso) return []

  function dateToIso(d: Date): string {
    return d.toISOString().slice(0, 10)
  }

  function addDays(d: Date, n: number): Date {
    const r = new Date(d)
    r.setUTCDate(r.getUTCDate() + n)
    return r
  }

  const startMs = new Date(`${startDateIso}T00:00:00Z`).getTime()
  if (isNaN(startMs)) return []

  const start = new Date(startMs)
  const results: string[] = []

  if (state.freq === 'DAILY') {
    let cur = new Date(start)
    for (let i = 0; i < count; i++) {
      results.push(dateToIso(cur))
      cur = addDays(cur, 1)
    }
    return results
  }

  if (state.freq === 'WEEKLY') {
    const selectedDays = state.byDay ?? []
    if (selectedDays.length === 0) return []
    const jsNums = selectedDays.map((d) => WEEKDAY_JS[d]).sort()
    let cur = new Date(start)
    for (let i = 0; results.length < count && i < 400; i++) {
      if (jsNums.includes(cur.getUTCDay())) {
        results.push(dateToIso(cur))
      }
      cur = addDays(cur, 1)
    }
    return results
  }

  if (state.freq === 'MONTHLY') {
    let monthsAhead = 0
    for (let i = 0; results.length < count && i < 48; i++) {
      const y = start.getUTCFullYear()
      const mo = start.getUTCMonth() + monthsAhead
      const year = y + Math.floor(mo / 12)
      const month = mo % 12

      let candidate: Date | null = null

      if (state.byDayNth) {
        const { n, day } = state.byDayNth
        const targetJsDay = WEEKDAY_JS[day]
        if (n === -1) {
          // Last occurrence: start from last day of month and go backward
          const lastDay = new Date(Date.UTC(year, month + 1, 0))
          let d = lastDay
          while (d.getUTCDay() !== targetJsDay) {
            d = addDays(d, -1)
          }
          candidate = d
        } else {
          // nth occurrence
          const firstDay = new Date(Date.UTC(year, month, 1))
          let d = firstDay
          while (d.getUTCDay() !== targetJsDay) {
            d = addDays(d, 1)
          }
          // advance (n-1) more weeks
          d = addDays(d, (n - 1) * 7)
          // Check still in same month
          if (d.getUTCMonth() === month) candidate = d
        }
      } else {
        const day = state.byMonthDay ?? start.getUTCDate()
        // Check day is valid in this month
        const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
        if (day <= daysInMonth) {
          candidate = new Date(Date.UTC(year, month, day))
        }
        // else: skip this month (e.g. Feb 31)
      }

      if (candidate && candidate.getTime() >= start.getTime()) {
        results.push(dateToIso(candidate))
      }
      monthsAhead++
    }
    return results
  }

  if (state.freq === 'YEARLY') {
    const mo = (state.byMonth ?? (start.getUTCMonth() + 1)) - 1
    const day = state.byYearMonthDay ?? start.getUTCDate()
    let year = start.getUTCFullYear()
    for (let i = 0; results.length < count && i < count + 4; i++) {
      const daysInMonth = new Date(Date.UTC(year, mo + 1, 0)).getUTCDate()
      if (day <= daysInMonth) {
        const candidate = new Date(Date.UTC(year, mo, day))
        if (candidate.getTime() >= start.getTime()) {
          results.push(dateToIso(candidate))
        }
      }
      year++
    }
    return results
  }

  return []
}
