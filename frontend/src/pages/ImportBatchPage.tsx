import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Alert } from '@connor-adams/designsystem'
import { Badge } from '@connor-adams/designsystem'
import { Button } from '@connor-adams/designsystem'
import { Card } from '@connor-adams/designsystem'
import { EmptyState } from '@connor-adams/designsystem'
import { PageHeader } from '@/components/ui/page-header'
import { SectionHeader } from '@/components/ui/section-header'
import { Skeleton } from '@connor-adams/designsystem'
import { useToast } from '@/components/ui/toast'
import { AICleanupPanel } from '../components/import/AICleanupPanel'
import type { ImportHistoryRow } from '../components/import/ImportHistoryTable'
import { RollbackDialog } from '../components/import/RollbackDialog'
import { getJson } from '../lib/api'

const DEFAULT_IMPORT_BATCH_CURRENCY = 'CAD'

/**
 * `BatchDetailRow` is the wire shape returned by `GET /api/import/batches/:id`
 * (#231) — `ImportHistoryRow` plus the parent account snapshot. Used as the
 * single source of truth for the page so the same shape can come from either
 * the id-based detail endpoint or the legacy history list fallback.
 */
export type BatchDetailRow = ImportHistoryRow & {
  account?: {
    id: number
    name: string
    shortCode: string | null
    accountType: string
  } | null
}

/**
 * `/import/:batchId` — per-batch detail. The URL parameter is interpreted in
 * two ways for backward compatibility:
 *
 * 1. Numeric → hits `GET /api/import/batches/:id` (#231) which returns the
 *    full structured batch + account snapshot in a single round trip.
 * 2. Non-numeric (legacy label-shaped bookmarks) → falls back to
 *    `GET /api/import/history` and finds the row by `batchLabel`. We do not
 *    enrich with the account snapshot in this path because the history
 *    endpoint does not include it; the page renders gracefully without it.
 *
 * The batch id segment is URI-encoded by the caller (`ImportPage`); we decode
 * it before using it as a label or filter value.
 *
 * If neither lookup matches, the page renders a "Batch not found" empty state
 * so stale URLs stay safe.
 */
export function ImportBatchPage() {
  const params = useParams<{ batchId: string }>()
  const rawParam = decodeURIComponent(params.batchId ?? '')
  const numericId = /^\d+$/.test(rawParam) ? Number(rawParam) : null
  const [row, setRow] = useState<BatchDetailRow | null | undefined>(undefined)
  const [rollbackOpen, setRollbackOpen] = useState(false)
  const { showToast } = useToast()

  const [celebrated, setCelebrated] = useState(false)

  const load = useCallback(async () => {
    try {
      if (numericId != null) {
        const detail = await getJson<BatchDetailRow>(
          `/api/import/batches/${numericId}`,
        )
        setRow(detail)
        if (!celebrated && detail.status === 'done' && (detail.rowCount ?? 0) > 0) {
          showToast({
            title: '🎉 Import complete!',
            description: `${detail.rowCount} transaction${detail.rowCount === 1 ? '' : 's'} imported. Review any flagged items below.`,
          })
          setCelebrated(true)
        }
        return
      }
      // Legacy label-shaped URL: scan the history list and pick the row
      // whose label matches. Keeps existing bookmarks working without a
      // new server-side index.
      const list = await getJson<ImportHistoryRow[]>('/api/import/history')
      const match = list.find((r) => r.batchLabel === rawParam) ?? null
      setRow(match)
      if (match && !celebrated && match.status === 'done' && (match.rowCount ?? 0) > 0) {
        showToast({
          title: '🎉 Import complete!',
          description: `${match.rowCount} transaction${match.rowCount === 1 ? '' : 's'} imported. Review any flagged items below.`,
        })
        setCelebrated(true)
      }
    } catch {
      setRow(null)
    }
  }, [numericId, rawParam, celebrated, setCelebrated, showToast])

  useEffect(() => {
    let cancelled = false
    void load().catch(() => {
      if (!cancelled) setRow(null)
    })
    return () => {
      cancelled = true
    }
  }, [load])

  // Resolve a stable label for the AICleanupPanel: prefer the actual batch
  // label from the loaded row; fall back to the URL slug while loading.
  const batchLabel = row?.batchLabel ?? rawParam
  const transactionsQuery = new URLSearchParams()
  transactionsQuery.set('importBatch', batchLabel)
  transactionsQuery.set('currency', DEFAULT_IMPORT_BATCH_CURRENCY)

  if (row === undefined) {
    return (
      <div className="page space-y-4">
        <PageHeader title={`Import ${batchLabel}`} />
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }

  if (!row) {
    return (
      <div className="page">
        <PageHeader title={`Import ${batchLabel}`} />
        <EmptyState
          title="Batch not found"
          description={
            <>
              No import run is recorded for{' '}
              <code>{batchLabel}</code>. The bookmark may be stale, or the run was
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
    row.startedAt.slice(0, 19).replace('T', ' '),
    row.fileName,
    `${row.rowCount ?? '—'} row${row.rowCount === 1 ? '' : 's'}`,
    row.status,
  ].join(' · ')

  const cleanCount = row.cleanCount ?? 0
  const needsReviewCount = row.needsReviewCount ?? 0
  const unknownCount = row.unknownCount ?? 0
  const classified = cleanCount + needsReviewCount
  const isRolledBack = row.status === 'rolled_back'

  const insertedCount = row.insertedCount
  const skippedDuplicateCount = row.skippedDuplicateCount
  const rowErrorsCount = row.rowErrorsCount
  const hasStageCounts =
    insertedCount != null ||
    skippedDuplicateCount != null ||
    rowErrorsCount != null

  return (
    <div className="page">
      <PageHeader title={`Import ${row.batchLabel}`} description={description} />
      <Card aria-label="Batch summary">
        <SectionHeader
          title="Batch summary"
          description={
            <>
              File: <strong>{row.fileName}</strong> · Status:{' '}
              <strong>{row.status}</strong>
              {row.account ? (
                <>
                  {' · '}Account: <strong>{row.account.name}</strong>
                </>
              ) : null}
              {row.profileId ? (
                <>
                  {' · '}Profile: <code>{row.profileId}</code>
                </>
              ) : null}
            </>
          }
          actions={
            <>
              <Link to={`/transactions?${transactionsQuery.toString()}`}>
                <Button variant="outline">
                  View transactions →
                </Button>
              </Link>
              {!isRolledBack ? (
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => setRollbackOpen(true)}
                  aria-label={`Roll back import batch ${row.batchLabel}`}
                >
                  Roll back batch
                </Button>
              ) : null}
            </>
          }
        >
          {row.errorMessage ? (
            <Alert variant="error" className="mt-2">
              {row.errorMessage}
            </Alert>
          ) : null}
          {/* Rollback marker (#233). Rendered when the batch carries
              rolled_back state — preserves audit trail on the page. */}
          {isRolledBack && row.rolledBackAt ? (
            <p className="mt-1 text-xs text-danger">
              Rolled back at{' '}
              {row.rolledBackAt.slice(0, 19).replace('T', ' ')}.
              Transactions were deleted; the row is kept for the audit
              trail.
            </p>
          ) : null}
          {/* Per-stage import counts (#231). Renders only when the row
              actually has counts captured — legacy rows show nothing
              here. */}
          {hasStageCounts ? (
            <div
              className="mt-2 flex flex-wrap items-center gap-2"
              aria-label="Batch stage counts"
            >
              {insertedCount != null ? (
                <Badge variant="count">{insertedCount} imported</Badge>
              ) : null}
              {skippedDuplicateCount != null && skippedDuplicateCount > 0 ? (
                <Badge variant="count">
                  {skippedDuplicateCount} duplicate{skippedDuplicateCount === 1 ? '' : 's'} skipped
                </Badge>
              ) : null}
              {rowErrorsCount != null && rowErrorsCount > 0 ? (
                <Badge variant="count" className="text-danger">
                  {rowErrorsCount} row error{rowErrorsCount === 1 ? '' : 's'}
                </Badge>
              ) : null}
            </div>
          ) : null}
          {/* Per-batch import-confidence breakdown (#214). Renders a small
              green/amber summary when the batch was classified; quiet when
              the batch predates the classifier. */}
          {classified > 0 || unknownCount > 0 ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Badge variant="count" className="text-positive">
                {cleanCount} clean
              </Badge>
              {needsReviewCount > 0 ? (
                <Link
                  to={`/review?confidenceFlag=needs_review`}
                  className="underline-offset-2 hover:underline"
                >
                  <Badge variant="count" className="text-warning">
                    {needsReviewCount} need review
                  </Badge>
                </Link>
              ) : null}
              {unknownCount > 0 ? (
                <span className="text-xs text-muted-foreground">
                  {unknownCount} legacy (not classified)
                </span>
              ) : null}
            </div>
          ) : null}
        </SectionHeader>
      </Card>
      <AICleanupPanel batchId={batchLabel} currency={DEFAULT_IMPORT_BATCH_CURRENCY} />
      <RollbackDialog
        open={rollbackOpen}
        batchLabel={row.batchLabel}
        onClose={() => setRollbackOpen(false)}
        onRolledBack={(result) => {
          showToast({
            title: 'Batch rolled back',
            description: `Removed ${result.deletedTransactions} transaction${
              result.deletedTransactions === 1 ? '' : 's'
            }.`,
          })
          void load()
        }}
      />
    </div>
  )
}
