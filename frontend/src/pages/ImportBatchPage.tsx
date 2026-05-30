import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/ui/page-header'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/toast'
import { AICleanupPanel } from '../components/import/AICleanupPanel'
import type { ImportHistoryRow } from '../components/import/ImportHistoryTable'
import { RollbackDialog } from '../components/import/RollbackDialog'
import { getJson } from '../lib/api'

type ActivationState = {
  hasAccounts: boolean
  unreviewedCount: number
  hasBudget: boolean
  hasGoal: boolean
  hasOutboundInvite: boolean
  dismissedCards: string[]
}

/** Returns the path and label of the highest-priority unfinished activation step. */
function nextActivationStep(
  state: ActivationState,
): { path: string; label: string } | null {
  if (!state.hasAccounts) return null // they just imported, accounts exist now — skip import step
  if (state.unreviewedCount > 0) return { path: '/review', label: 'Review transactions' }
  if (!state.hasBudget) return { path: '/settings/budgets', label: 'Set a budget' }
  if (!state.hasGoal) return { path: '/goals', label: 'Set a financial goal' }
  if (!state.hasOutboundInvite) return { path: '/settings/members', label: 'Invite a household member' }
  return null
}

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
  const navigate = useNavigate()
  // Guard: only fire the celebration toast once per page load.
  const celebrationFired = useRef(false)

  const load = useCallback(async () => {
    try {
      if (numericId != null) {
        const detail = await getJson<BatchDetailRow>(
          `/api/import/batches/${numericId}`,
        )
        setRow(detail)
        return
      }
      // Legacy label-shaped URL: scan the history list and pick the row
      // whose label matches. Keeps existing bookmarks working without a
      // new server-side index.
      const list = await getJson<ImportHistoryRow[]>('/api/import/history')
      const match = list.find((r) => r.batchLabel === rawParam) ?? null
      setRow(match)
    } catch {
      setRow(null)
    }
  }, [numericId, rawParam])

  useEffect(() => {
    let cancelled = false
    void load().catch(() => {
      if (!cancelled) setRow(null)
    })
    return () => {
      cancelled = true
    }
  }, [load])

  // Post-import celebration toast (#274). Fires once when a successful
  // (non-rolled-back) batch loads for the first time. Fetches activation
  // state in parallel so the "Next:" action points at the highest-priority
  // unfinished step.
  useEffect(() => {
    if (row == null || row === undefined) return
    if (row.status === 'rolled_back') return
    if (celebrationFired.current) return
    celebrationFired.current = true

    const txCount = row.insertedCount ?? 0
    const accountName = row.account?.name ?? null
    const title = accountName
      ? `Imported ${txCount} transaction${txCount === 1 ? '' : 's'} to ${accountName}`
      : `Imported ${txCount} transaction${txCount === 1 ? '' : 's'}`

    // Fetch activation state to build the next-step action. Show the toast
    // regardless of whether the fetch succeeds — the action is optional.
    getJson<ActivationState>('/api/activation-state')
      .then((state) => {
        const next = nextActivationStep(state)
        showToast({
          title,
          variant: 'success',
          ...(next
            ? {
                action: {
                  label: `Next: ${next.label}`,
                  onClick: () => navigate(next.path),
                },
              }
            : {}),
        })
      })
      .catch(() => {
        showToast({ title, variant: 'success' })
      })
  }, [row, showToast, navigate])

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
      <section className="card transactionsPanel" aria-label="Batch summary">
        <div className="transactionsPanelHeader">
          <div>
            <h2>Batch summary</h2>
            <p className="muted">
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
              {row.errorMessage ? (
                <>
                  {' · '}
                  <span className="error">{row.errorMessage}</span>
                </>
              ) : null}
            </p>
            {/* Rollback marker (#233). Rendered when the batch carries
                rolled_back state — preserves audit trail on the page. */}
            {isRolledBack && row.rolledBackAt ? (
              <p className="mt-1 text-xs text-red-700 dark:text-red-300">
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
                className="mt-2 flex flex-wrap items-center gap-2 text-xs"
                aria-label="Batch stage counts"
              >
                {insertedCount != null ? (
                  <span
                    className="rounded px-2 py-0.5 font-semibold"
                    style={{ backgroundColor: 'var(--bg2)', color: 'var(--fg)' }}
                  >
                    {insertedCount} imported
                  </span>
                ) : null}
                {skippedDuplicateCount != null && skippedDuplicateCount > 0 ? (
                  <span
                    className="rounded px-2 py-0.5 font-semibold"
                    style={{ backgroundColor: 'var(--bg2)', color: 'var(--fg)' }}
                  >
                    {skippedDuplicateCount} duplicate{skippedDuplicateCount === 1 ? '' : 's'} skipped
                  </span>
                ) : null}
                {rowErrorsCount != null && rowErrorsCount > 0 ? (
                  <span
                    className="rounded px-2 py-0.5 font-semibold text-red-700 dark:text-red-300"
                    style={{ backgroundColor: 'var(--bg2)' }}
                  >
                    {rowErrorsCount} row error{rowErrorsCount === 1 ? '' : 's'}
                  </span>
                ) : null}
              </div>
            ) : null}
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
          <div className="flex flex-wrap items-center gap-2">
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
          </div>
        </div>
      </section>
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
