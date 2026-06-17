import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { BentoTile } from './BentoTile'
import { Button } from '@/components/ui/button'
import { useImportHealth } from '@/hooks/useImportHealth'
import type { ImportConfidenceFlagToken } from '@cashflow/shared'

function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio)) return '0%'
  return `${Math.round(ratio * 100)}%`
}

const FLAG_LABEL: Record<ImportConfidenceFlagToken, string> = {
  needs_review: 'Needs review',
  missing_category: 'Missing category',
  missing_split: 'Missing split',
  likely_duplicate: 'Likely duplicate',
  possible_refund_pair: 'Refund pair',
  missing_receipt: 'Missing receipt',
}

type Props = {
  /**
   * Defaults to 'CAD' to match DEFAULT_DASHBOARD_CURRENCY. Pass `null` to
   * aggregate across all currencies. The dashboard filter bar threads its
   * current selection through here.
   */
  currency?: string | null
}

/**
 * Dashboard tile (#214). Shows overall import health: the percent of
 * classified rows that are 'clean', clean / needs-review counts, and a
 * compact breakdown of the top blocking flags. Clicking through routes to
 * the Review Inbox with a flag chip preselected. Legacy 'unknown' rows
 * (imported before the classifier landed) are reported in a small footnote.
 */
export function ImportHealthTile({ currency = 'CAD' }: Props) {
  const { data, loading, error } = useImportHealth(currency ?? null)

  const cleanPercent = data?.cleanPercent ?? 0
  const clean = data?.clean ?? 0
  const needsReview = data?.needsReview ?? 0
  const unknown = data?.unknown ?? 0
  const total = data?.total ?? 0

  const topFlags = useMemo(() => {
    if (!data?.byFlag) return [] as { token: ImportConfidenceFlagToken; count: number }[]
    return (Object.entries(data.byFlag) as [ImportConfidenceFlagToken, number][])
      .filter(([token, count]) => count > 0 && token !== 'needs_review')
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([token, count]) => ({ token, count }))
  }, [data])

  const headline = useMemo(() => {
    if (total === 0) return 'No imports yet.'
    if (clean + needsReview === 0) {
      return `${unknown} legacy transaction${unknown === 1 ? '' : 's'} not yet classified.`
    }
    if (needsReview === 0) {
      return `Every classified transaction is clean (${clean}).`
    }
    return `${needsReview} of ${clean + needsReview} need a closer look.`
  }, [clean, needsReview, unknown, total])

  return (
    <BentoTile
      span={6}
      rows={2}
      aria-busy={loading}
      label="Import health"
      description="Share of imported transactions classified as clean after rules + enrichment. Updates after each import."
    >
      {loading && !data ? (
        <p className="text-sm text-muted-foreground">Loading import health…</p>
      ) : error ? (
        <p className="text-sm text-muted-foreground">
          {error.message || 'Import health unavailable.'}
        </p>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
            <div>
              <div className="text-3xl font-semibold tabular-nums">
                {formatPercent(cleanPercent)}
              </div>
              <div className="text-xs text-muted-foreground">Clean</div>
            </div>
            <div>
              <div className="text-2xl font-semibold tabular-nums">{needsReview}</div>
              <div className="text-xs text-muted-foreground">Need review</div>
            </div>
            <div>
              <div className="text-2xl font-semibold tabular-nums">{clean}</div>
              <div className="text-xs text-muted-foreground">Clean rows</div>
            </div>
          </div>
          <p className="text-sm text-foreground">{headline}</p>

          {topFlags.length > 0 ? (
            <div className="rounded-md border border-border bg-muted/40 p-2">
              <p className="mb-1 text-xs font-semibold text-muted-foreground">
                Top flags
              </p>
              <ul className="space-y-1 text-sm">
                {topFlags.map(({ token, count }) => (
                  <li key={token} className="flex items-baseline justify-between gap-2">
                    <Link
                      to={`/review?confidenceFlag=${token}`}
                      className="truncate font-medium hover:underline"
                    >
                      {FLAG_LABEL[token]}
                    </Link>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {count}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="flex flex-wrap gap-3">
            <Button asChild size="sm"><Link to="/review">Open Review Inbox</Link></Button>
            <Button asChild size="sm" variant="outline"><Link to="/import">See recent imports</Link></Button>
          </div>

          {unknown > 0 ? (
            <p className="text-xs text-muted-foreground">
              {unknown} legacy transaction{unknown === 1 ? '' : 's'} predate the
              confidence classifier and aren&apos;t scored yet.
            </p>
          ) : null}
        </div>
      )}
    </BentoTile>
  )
}
