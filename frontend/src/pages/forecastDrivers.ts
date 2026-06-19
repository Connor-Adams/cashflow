import type { ForecastEvent, ForecastEventSource } from '../types/api'

/**
 * Maximum number of driver rows shown before collapsing the remainder
 * behind a "+N more" control (AC6).
 */
export const MAX_VISIBLE_DRIVERS = 8

/**
 * Derive the occurrences driving a below-zero forecast dip, client-side,
 * from the already-fetched ForecastResponse. No extra network request.
 *
 * Smallest-version rule from issue #652: list every `out` occurrence dated
 * on-or-before the lowest-balance date, sorted by amount descending. These
 * are the charges that pushed the running balance into the dip.
 *
 * Returns [] when there is no dip date or no qualifying outflow — callers
 * render a defensive "no individual charges to attribute" fallback.
 */
export function deriveDipDrivers(
  events: ForecastEvent[],
  lowestProjectedBalanceDate: string | null,
): ForecastEvent[] {
  if (!lowestProjectedBalanceDate) return []
  return events
    .filter((e) => e.direction === 'out' && e.date <= lowestProjectedBalanceDate)
    .slice()
    .sort((a, b) => b.amount - a.amount)
}

/**
 * Deep-link target for a forecast occurrence, by source type.
 *
 * - `planned_event` → the planned-events page focused on the source row.
 *   `sourceId` is the stable planned_events DB id.
 * - `recurring_detection` → the recurring-charges list. Its `sourceId` is a
 *   synthetic per-request counter (not a stable DB id), so we can only link
 *   to the detector list, never a specific row.
 */
export function driverLinkTarget(
  sourceType: ForecastEventSource,
  sourceId: number,
): string {
  if (sourceType === 'recurring_detection') return '/planned/recurring'
  return `/planned?focus=${sourceId}`
}
