import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { getJson } from '../../lib/api'
import { formatMoney } from '../../lib/formatMoney'

type ImportCleanup = {
  batch: string | null
  total: number
  readyToConfirmCount: number
  needsCategoryCount: number
  alreadyReviewedCount: number
  topReady: Array<{
    id: number
    date: string
    merchant: string
    amount: number
    currency: string
    category: string | null
    source: 'rule' | 'merchant_memory'
  }>
  batches: Array<{ importBatch: string; count: number }>
}

type AICleanupPanelProps = {
  /** Batch label to scope the cleanup query to. */
  batchId: string
  /** Currency filter passed through to the cleanup endpoint. */
  currency: string
}

/**
 * Per-batch AI cleanup panel extracted from `TransactionsPage`. Fetches
 * `/api/ai/import-cleanup?batch=<id>&currency=<x>` and renders the same
 * `.aiVisibilityPanel` JSX as before. The "Review cleanup queue" button is
 * now a `<Link>` into `/transactions?importBatch=…&reviewFlag=true` because
 * this panel no longer owns the transactions filters.
 */
export function AICleanupPanel({ batchId, currency }: AICleanupPanelProps) {
  const [importCleanup, setImportCleanup] = useState<ImportCleanup | null>(null)

  useEffect(() => {
    const cleanupQs = new URLSearchParams()
    if (batchId.trim()) cleanupQs.set('batch', batchId.trim())
    if (currency) cleanupQs.set('currency', currency)
    void getJson<ImportCleanup>(`/api/ai/import-cleanup?${cleanupQs.toString()}`)
      .then(setImportCleanup)
      .catch(() => setImportCleanup(null))
  }, [batchId, currency])

  if (!importCleanup || importCleanup.total === 0) {
    return null
  }

  const reviewQuery = new URLSearchParams()
  reviewQuery.set('importBatch', importCleanup.batch ?? batchId)
  reviewQuery.set('reviewFlag', 'true')
  if (currency) reviewQuery.set('currency', currency)

  return (
    <section className="card aiVisibilityPanel" aria-label="Import cleanup assistant">
      <div className="aiVisibilityHeader">
        <strong>Import cleanup</strong>
        <span className="muted">
          {importCleanup.readyToConfirmCount} auto-categorized ·{' '}
          {importCleanup.needsCategoryCount} need categories ·{' '}
          {importCleanup.alreadyReviewedCount} reviewed
        </span>
      </div>
      {importCleanup.readyToConfirmCount > 0 ? (
        <div className="aiVisibilityList">
          {importCleanup.topReady.slice(0, 6).map((row) => (
            <article key={row.id} className="aiVisibilityItem">
              <div className="aiVisibilityItemHeader">
                <strong>{row.merchant}</strong>
                <span className="muted">#{row.id}</span>
              </div>
              <p>
                {row.category ?? 'Uncategorized'} ·{' '}
                {formatMoney(Math.abs(row.amount), row.currency)}
              </p>
              <p className="muted">
                Source: {row.source === 'rule' ? 'rule' : 'merchant memory'}
              </p>
            </article>
          ))}
        </div>
      ) : (
        <p className="muted">
          Nothing is ready to confirm for the current filters.
        </p>
      )}
      <div className="row">
        <Link
          to={`/transactions?${reviewQuery.toString()}`}
          className="inline-flex h-10 items-center justify-center whitespace-nowrap rounded-lg border border-border px-4 font-semibold transition-colors hover:opacity-90"
          // --bg2/--fg are legacy aliases with no Tailwind utility; keep inline.
          style={{
            backgroundColor: 'var(--bg2)',
            color: 'var(--fg)',
          }}
        >
          Review cleanup queue
        </Link>
      </div>
    </section>
  )
}
