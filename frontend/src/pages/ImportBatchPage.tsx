import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { EmptyState } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/ui/page-header'
import { AICleanupPanel } from '../components/import/AICleanupPanel'
import type { ImportHistoryRow } from '../components/import/ImportHistoryTable'
import { getJson } from '../lib/api'

const DEFAULT_IMPORT_BATCH_CURRENCY = 'CAD'

/**
 * `/import/:batchId` — per-batch detail. Fetches `/api/import/history` (the
 * same endpoint the history table uses) and finds the row with the matching
 * batch label. Renders a header, a tiny inline batch summary, and the AI
 * cleanup panel. "View transactions →" deep-links into `/transactions` with
 * the batch filter pre-applied so the user lands on the editing surface.
 *
 * The batch id segment is URI-encoded by the caller (`ImportPage`); we decode
 * it before using it as a label or filter value.
 *
 * If the batch id does not match any history row the page renders a
 * "Batch not found" empty state — handles stale bookmarks gracefully.
 */
export function ImportBatchPage() {
  const params = useParams<{ batchId: string }>()
  const batchId = decodeURIComponent(params.batchId ?? '')
  const [history, setHistory] = useState<ImportHistoryRow[] | null>(null)

  useEffect(() => {
    void getJson<ImportHistoryRow[]>('/api/import/history')
      .then(setHistory)
      .catch(() => setHistory([]))
  }, [])

  const batchRow = history?.find((row) => row.batchLabel === batchId) ?? null
  const transactionsQuery = new URLSearchParams()
  transactionsQuery.set('importBatch', batchId)
  transactionsQuery.set('currency', DEFAULT_IMPORT_BATCH_CURRENCY)

  if (history === null) {
    return (
      <div className="page">
        <PageHeader title={`Import ${batchId}`} description="Loading batch detail…" />
      </div>
    )
  }

  if (!batchRow) {
    return (
      <div className="page">
        <PageHeader title={`Import ${batchId}`} />
        <EmptyState
          title="Batch not found"
          description={
            <>
              No import run is recorded for{' '}
              <code>{batchId}</code>. The bookmark may be stale, or the run was
              cleared from history.{' '}
              <Link to="/import" className="underline">
                Back to all imports
              </Link>
              .
            </>
          }
        />
      </div>
    )
  }

  const description = [
    batchRow.startedAt.slice(0, 19).replace('T', ' '),
    batchRow.fileName,
    `${batchRow.rowCount ?? '—'} row${batchRow.rowCount === 1 ? '' : 's'}`,
    batchRow.status,
  ].join(' · ')

  const cleanCount = batchRow.cleanCount ?? 0
  const needsReviewCount = batchRow.needsReviewCount ?? 0
  const unknownCount = batchRow.unknownCount ?? 0
  const classified = cleanCount + needsReviewCount

  return (
    <div className="page">
      <PageHeader title={`Import ${batchRow.batchLabel}`} description={description} />
      <section className="card transactionsPanel" aria-label="Batch summary">
        <div className="transactionsPanelHeader">
          <div>
            <h2>Batch summary</h2>
            <p className="muted">
              File: <strong>{batchRow.fileName}</strong> · Status:{' '}
              <strong>{batchRow.status}</strong>
              {batchRow.errorMessage ? (
                <>
                  {' '}
                  · <span className="error">{batchRow.errorMessage}</span>
                </>
              ) : null}
            </p>
            {/* Per-batch import-confidence breakdown (#214). Renders a small
                green/amber summary when the batch was classified; quiet when
                the batch predates the classifier. */}
            {classified > 0 || unknownCount > 0 ? (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                <span className="rounded px-2 py-0.5 font-semibold text-green-700 dark:text-green-300" style={{ backgroundColor: 'var(--bg2)' }}>
                  {cleanCount} clean
                </span>
                {needsReviewCount > 0 ? (
                  <Link
                    to={`/review?confidenceFlag=needs_review`}
                    className="rounded px-2 py-0.5 font-semibold text-amber-700 underline-offset-2 hover:underline dark:text-amber-300"
                    style={{ backgroundColor: 'var(--bg2)' }}
                  >
                    {needsReviewCount} need review
                  </Link>
                ) : null}
                {unknownCount > 0 ? (
                  <span className="text-muted-foreground">
                    {unknownCount} legacy (not classified)
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
          <Link
            to={`/transactions?${transactionsQuery.toString()}`}
            className="inline-flex h-10 items-center justify-center whitespace-nowrap rounded-lg border px-4 font-semibold transition-colors hover:opacity-90"
            style={{
              backgroundColor: 'var(--bg2)',
              color: 'var(--fg)',
              borderColor: 'var(--border)',
            }}
          >
            View transactions →
          </Link>
        </div>
      </section>
      <AICleanupPanel batchId={batchId} currency={DEFAULT_IMPORT_BATCH_CURRENCY} />
    </div>
  )
}
