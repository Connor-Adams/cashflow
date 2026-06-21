import { Link } from 'react-router-dom'
import { useActiveImports, type BatchSummary } from './useActiveImports'

function etaText(b: Pick<BatchSummary, 'processed' | 'total' | 'startedAt'>): string {
  if (!b.startedAt || b.processed === 0) return ''
  const elapsed = Date.now() - new Date(b.startedAt).getTime()
  const remaining = (elapsed / b.processed) * (b.total - b.processed)
  const m = Math.round(remaining / 60000)
  return m > 0 ? ` · ~${m}m` : ' · <1m'
}

export function ImportProgressBadge() {
  const { activeBatches } = useActiveImports()
  if (activeBatches.length === 0) return null
  const b = activeBatches[0]
  return (
    <Link
      to="/imports"
      className="inline-flex items-center gap-1.5 rounded-md border border-transparent bg-muted px-2 py-0.5 text-xs font-medium whitespace-nowrap text-foreground hover:bg-muted/70"
    >
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" aria-hidden="true" />
      Importing {b.processed}/{b.total}{etaText(b)}
    </Link>
  )
}
