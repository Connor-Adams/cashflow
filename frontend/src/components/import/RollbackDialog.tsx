import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { getJson, postJson } from '../../lib/api'

/**
 * Backend RollbackImpact shape (mirrored from
 * backend/src/import/rollbackImportBatch.ts so the dialog can render the
 * full preview without a shared type contract). Keep the two shapes in sync
 * — the backend response is the source of truth.
 */
export type RollbackBlocker = {
  code:
    | 'already_rolled_back'
    | 'not_found'
    | 'cross_batch_link'
    | 'external_order_link'
    | 'linked_receipt'
    | 'outside_scope'
  message: string
  count?: number
}

export type RollbackImpact = {
  batchLabel: string
  importHistoryId: number | null
  canRollback: boolean
  blockers: RollbackBlocker[]
  transactionCount: number
  dependentCounts: {
    receipts: number
    aiSuggestions: number
    transactionSignals: number
    transactionTaxMetadata: number
    budgetExclusions: number
    plannedEventsUnlinked: number
    investmentActivities: number
    holdingSnapshots: number
  }
  sample: Array<{
    id: number
    date: string
    merchantClean: string
    amount: string
    currency: string
  }>
}

export type RollbackResult = {
  batchLabel: string
  deletedTransactions: number
  deletedReceipts: number
  deletedAiSuggestions: number
  deletedTransactionSignals: number
  deletedTransactionTaxMetadata: number
  deletedBudgetExclusions: number
  unlinkedPlannedEvents: number
  deletedInvestmentActivities: number
  deletedHoldingSnapshots: number
}

type RollbackDialogProps = {
  open: boolean
  batchLabel: string
  onClose: () => void
  /** Fires after a successful rollback (HTTP 200). Parent should refresh
   *  history + transactions. */
  onRolledBack: (result: RollbackResult) => void
}

/**
 * `RollbackDialog` — confirmation modal for rolling back an import batch
 * (#233). On open, it fetches `/rollback-preview` to surface affected
 * transaction + dependent counts and a small sample. The "Roll back batch"
 * button is disabled until the preview returns and `canRollback === true`.
 *
 * If the backend returns blockers, those render as a red-tinted list with
 * actionable copy ("12 transactions are linked to transfers in other
 * batches"). The user can only dismiss in that case; the rollback button is
 * suppressed.
 *
 * On successful POST, `onRolledBack` fires with the deletion counts so the
 * parent page can render a toast and re-fetch state.
 */
export function RollbackDialog({
  open,
  batchLabel,
  onClose,
  onRolledBack,
}: RollbackDialogProps) {
  const [impact, setImpact] = useState<RollbackImpact | null>(null)
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      setImpact(null)
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    void getJson<RollbackImpact>(
      `/api/import/history/${encodeURIComponent(batchLabel)}/rollback-preview`,
    )
      .then((data) => setImpact(data))
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : 'Could not load rollback preview')
      })
      .finally(() => setLoading(false))
  }, [open, batchLabel])

  async function handleRollback() {
    if (!impact || !impact.canRollback) return
    setSubmitting(true)
    setError(null)
    try {
      const result = await postJson<RollbackResult>(
        `/api/import/history/${encodeURIComponent(batchLabel)}/rollback`,
      )
      onRolledBack(result)
      onClose()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Rollback failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogHeader>
        <DialogTitle>Roll back import “{batchLabel}”?</DialogTitle>
        <DialogDescription>
          This deletes the transactions created by this import batch and the
          dependent records they spawned. Manual transactions and other
          batches are preserved.
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        {loading && <p className="muted">Loading preview…</p>}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        {impact && (
          <div className="space-y-3" data-testid="rollback-impact">
            <RollbackBlockerList blockers={impact.blockers} />
            <RollbackCounts impact={impact} />
            <RollbackSample sample={impact.sample} />
          </div>
        )}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="destructive"
          onClick={() => void handleRollback()}
          disabled={!impact?.canRollback || submitting}
          aria-disabled={!impact?.canRollback || submitting}
        >
          {submitting ? 'Rolling back…' : 'Roll back batch'}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}

function RollbackBlockerList({ blockers }: { blockers: RollbackBlocker[] }) {
  if (blockers.length === 0) return null
  return (
    <ul
      className="rounded border border-danger bg-danger-bg p-3 text-sm text-danger"
      data-testid="rollback-blockers"
    >
      {blockers.map((blocker) => (
        <li key={blocker.code} className="leading-relaxed">
          <strong className="font-semibold">{labelFor(blocker.code)}:</strong>{' '}
          {blocker.message}
        </li>
      ))}
    </ul>
  )
}

function RollbackCounts({ impact }: { impact: RollbackImpact }) {
  const counts = impact.dependentCounts
  const rows = [
    { label: 'Transactions to delete', value: impact.transactionCount },
    { label: 'Receipts to delete', value: counts.receipts },
    { label: 'AI suggestions to clear', value: counts.aiSuggestions },
    { label: 'Enrichment signals to clear', value: counts.transactionSignals },
    { label: 'Tax metadata to clear', value: counts.transactionTaxMetadata },
    { label: 'Budget exclusions to clear', value: counts.budgetExclusions },
    { label: 'Planned events to unlink', value: counts.plannedEventsUnlinked },
    { label: 'Investment activities to delete', value: counts.investmentActivities },
    { label: 'Holding snapshots to delete', value: counts.holdingSnapshots },
  ]
  return (
    <dl
      className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm"
      data-testid="rollback-counts"
    >
      {rows.map((row) => (
        <div key={row.label} className="contents">
          <dt className="text-muted-foreground">{row.label}</dt>
          <dd className="tabular-nums">{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}

function RollbackSample({ sample }: { sample: RollbackImpact['sample'] }) {
  if (sample.length === 0) return null
  return (
    <div className="space-y-1 text-xs" data-testid="rollback-sample">
      <p className="muted">Sample (up to 5):</p>
      <ul className="space-y-0.5">
        {sample.map((row) => (
          <li key={row.id} className="flex justify-between gap-4 tabular-nums">
            <span>
              <span className="text-muted-foreground">{row.date}</span>{' '}
              <span>{row.merchantClean}</span>
            </span>
            <span>
              {row.amount} {row.currency}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function labelFor(code: RollbackBlocker['code']): string {
  switch (code) {
    case 'already_rolled_back':
      return 'Already rolled back'
    case 'not_found':
      return 'Not found'
    case 'cross_batch_link':
      return 'Cross-batch link'
    case 'external_order_link':
      return 'External order link'
    case 'linked_receipt':
      return 'Linked receipt'
    case 'outside_scope':
      return 'Outside your scope'
  }
}
