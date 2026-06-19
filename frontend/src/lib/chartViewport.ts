import { useEffect, useState } from 'react'

// Narrow-viewport breakpoint for chart layout tweaks. 480px catches phones in
// portrait (iPhone SE 375, iPhone 14 Pro Max 430, Pixel 7 412) while leaving
// medium tablets on the desktop layout. Below this, Recharts axis labels and
// legends overlap with default settings.
export const NARROW_VIEWPORT_BREAKPOINT_PX = 480

const SHORT_MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

/**
 * Subscribe to a `(max-width: <px>)` media query. Returns true when the
 * viewport is narrower than the breakpoint. Defaults to the shared
 * NARROW_VIEWPORT_BREAKPOINT_PX so chart pages can call with no arguments.
 */
export function useIsNarrowViewport(
  maxWidthPx: number = NARROW_VIEWPORT_BREAKPOINT_PX,
): boolean {
  const query = `(max-width: ${maxWidthPx}px)`
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return window.matchMedia(query).matches
  })
  useEffect(() => {
    if (typeof window === 'undefined') return
    const mql = window.matchMedia(query)
    const handler = (event: MediaQueryListEvent) => setMatches(event.matches)
    setMatches(mql.matches)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [query])
  return matches
}

// "2025-03" -> "Mar". Falls back to the input on malformed values so a bad
// label is still legible rather than blank.
export function formatShortMonth(value: string): string {
  if (typeof value !== 'string') return String(value)
  const parts = value.split('-')
  if (parts.length < 2) return value
  const monthIndex = Number(parts[1]) - 1
  if (!Number.isInteger(monthIndex) || monthIndex < 0 || monthIndex > 11) {
    return value
  }
  return SHORT_MONTH_NAMES[monthIndex]
}

// Compact currency formatter for narrow-viewport axis ticks: 1234 -> "$1.2k",
// 1500000 -> "$1.5M". Returns the same currency symbol as the full formatter
// by relying on Intl.NumberFormat compact notation.
export function formatCompactMoney(value: number, currency: string | null): string {
  if (!Number.isFinite(value)) return ''
  try {
    if (currency) {
      return new Intl.NumberFormat('en-CA', {
        style: 'currency',
        currency,
        notation: 'compact',
        maximumFractionDigits: 1,
      }).format(value)
    }
    return new Intl.NumberFormat(undefined, {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(value)
  } catch {
    return new Intl.NumberFormat(undefined, {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(value)
  }
}
