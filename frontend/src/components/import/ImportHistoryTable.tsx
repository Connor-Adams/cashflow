import { useCallback, useEffect, useState } from 'react'
import { Button } from '@connor-adams/designsystem'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@connor-adams/designsystem'
import { getJson } from '../../lib/api'

export type ImportHistoryRow = {
  id: number
  fileName: string
  batchLabel: string
  status: string
  rowCount: number | null
  errorMessage: string | null
  startedAt: string
  finishedAt: string | null
  /** Per-batch confidence counts (#214). Backend extends each ImportHistory
   *  row with these so the table can render clean / needs-review badges
   *  without a second roundtrip. */
  cleanCount?: number
  needsReviewCount?: number
  unknownCount?: number
  /** Import batch manager metadata (#231). NULL on rows imported before
   *  #231 landed. */
  accountId?: number | null
  profileId?: string | null
  insertedCount?: number | null
  skippedDuplicateCount?: number | null
  rowErrorsCount?: number | null
  /** Rollback markers (#233). Both NULL on healthy batches; populated when
   *  the batch has been rolled back. Drives the rolled-back status pill
   *  in `ImportBatchPage`. */
  rolledBackAt?: string | null
  rolledBackByUserId?: number | null
}

type ImportHistoryTableProps = {
  /** Fires when the user clicks the action button on a history row. The
   *  full row is forwarded so callers can navigate by id (preferred, #231)
   *  or by batch label (legacy). */
  onRowClick: (row: ImportHistoryRow) => void
  /** Bump this value (e.g. from an UploadCard `onCommitted` callback) to
   *  trigger a re-fetch of `/api/import/history`. */
  refreshKey?: number
  /** Optional label override for the row action button. Defaults to
   *  "Open batch". */
  actionLabel?: string
  /** Fires after each successful fetch with the number of history rows, so
   *  a parent (e.g. ImportPage) can show a page-level empty state. Receives
   *  the count; not called on fetch error. */
  onLoaded?: (count: number) => void
}

/**
 * Import history table extracted from `TransactionsPage`. Renders the last
 * 50 import runs and emits the batch label via `onRowClick` so callers can
 * either navigate to `/import/:batchId` or filter the transactions table
 * by batch. Bump `refreshKey` after a successful upload to force a refetch.
 */
export function ImportHistoryTable({
  onRowClick,
  refreshKey = 0,
  actionLabel = 'Open batch',
  onLoaded,
}: ImportHistoryTableProps) {
  const [importHistory, setImportHistory] = useState<ImportHistoryRow[]>([])

  const refreshImportHistory = useCallback(() => {
    void getJson<ImportHistoryRow[]>('/api/import/history')
      .then((rows) => {
        setImportHistory(rows)
        onLoaded?.(rows.length)
      })
      .catch(() => {})
  }, [onLoaded])

  useEffect(() => {
    refreshImportHistory()
  }, [refreshImportHistory, refreshKey])

  return (
    <section
      className="card transactionsPanel transactionsHistoryCard"
      aria-labelledby="import-history-heading"
    >
      <div className="transactionsPanelHeader">
        <div>
          <h2 id="import-history-heading">Recent imports</h2>
          <p className="muted">
            Last 50 runs. Click a row to drill into the batch.
          </p>
        </div>
      </div>
      <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Started</TableHead>
              <TableHead>File</TableHead>
              <TableHead>Batch</TableHead>
              <TableHead>Profile</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Rows</TableHead>
              <TableHead>Quality</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {importHistory.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="muted pad">
                  No import history yet.
                </TableCell>
              </TableRow>
            ) : (
              importHistory.map((h) => {
                const clean = h.cleanCount ?? 0
                const needsReview = h.needsReviewCount ?? 0
                const classified = clean + needsReview
                return (
                  <TableRow key={h.id}>
                    <TableCell>{h.startedAt.slice(0, 19).replace('T', ' ')}</TableCell>
                    <TableCell title={h.fileName}>{h.fileName}</TableCell>
                    <TableCell>{h.batchLabel}</TableCell>
                    <TableCell className="text-xs">
                      {h.profileId ? <code>{h.profileId}</code> : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell>
                      {h.status}
                      {h.errorMessage ? (
                        <span className="muted" title={h.errorMessage}>
                          {' '}
                          ({h.errorMessage.slice(0, 40)}
                          {h.errorMessage.length > 40 ? '…' : ''})
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell>{h.rowCount ?? '—'}</TableCell>
                    <TableCell className="text-xs tabular-nums">
                      {classified === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <span className="flex items-center gap-1.5">
                          <span
                            className="rounded px-1.5 py-0.5 text-positive"
                            style={{ backgroundColor: 'var(--bg2)' }}
                            title={`${clean} clean`}
                          >
                            {clean} clean
                          </span>
                          {needsReview > 0 ? (
                            <span
                              className="rounded px-1.5 py-0.5 text-warning"
                              style={{ backgroundColor: 'var(--bg2)' }}
                              title={`${needsReview} need review`}
                            >
                              {needsReview} review
                            </span>
                          ) : null}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Button
                        type="button"
                        variant="link"
                        size="sm"
                        onClick={() => onRowClick(h)}
                      >
                        {actionLabel}
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
    </section>
  )
}
