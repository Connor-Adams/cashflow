import type { LifestyleScope } from '../../types/api'

/** Rolling-window sizes offered by the rolling-window report pages. */
export const WINDOW_OPTIONS = [6, 12, 18, 24]

export type ScopeOption = { value: LifestyleScope; label: string }

/** Default anchor is the current calendar month in the browser's local
 *  timezone. The backend treats YYYY-MM as a pure label. */
export function defaultReportMonth(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
