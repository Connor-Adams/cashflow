/** Human freshness label for the Amazon capture sync chip. `now` is injected
 *  for deterministic tests; defaults to the current time in the app. */
export function formatSyncAge(iso: string | null, now: Date = new Date()): string {
  if (!iso) return 'Never synced'
  const then = new Date(iso).getTime()
  const secs = Math.max(0, Math.round((now.getTime() - then) / 1000))
  if (secs < 60) return 'Synced just now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `Synced ${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `Synced ${hours}h ago`
  const days = Math.round(hours / 24)
  return `Synced ${days}d ago`
}
