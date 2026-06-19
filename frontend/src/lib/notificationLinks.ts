import type { Notification } from '@/types/api'

/**
 * Resolve a notification's deep link (issue #651). Prefers an explicit
 * `dataJson.link`, then a per-type default. Mirrors the service worker's
 * `deepLinkFromPayload` (frontend/public/sw.js) so a click from either the
 * OS push or the dashboard tile lands on the same place.
 */
export function deepLinkForNotification(n: Notification): string {
  const data = n.dataJson ?? {}
  const link = (data as Record<string, unknown>).link
  if (typeof link === 'string' && link) return link
  if (n.type === 'budget.breach' || 'budgetId' in data) return '/budgets'
  // digest.weekly and anything else land on the dashboard.
  return '/'
}
