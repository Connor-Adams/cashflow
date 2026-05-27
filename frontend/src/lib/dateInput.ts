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
