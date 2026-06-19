import { useEffect, useState } from 'react'
import { Button } from '@cashflow/ui'
import {
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@cashflow/ui'
import { Badge } from '@cashflow/ui'
import { getJson, postJson } from '../lib/api'
import type { Transaction } from '../types/api'

/**
 * Issue #229: per-transaction version history viewer + restore.
 *
 * Renders the timeline returned by GET /api/transactions/:id/revisions
 * (oldest -> newest), one entry per recorded edit. Each entry shows:
 *   - actor + source badge (user_edit / bulk_patch / ai_suggestion /
 *     refund_link / import / enrichment / restore / system)
 *   - field-level diff (before -> after) for every changed REVISIONED_FIELDS
 *     entry
 *   - a Restore button when the revision contains at least one field in
 *     the server-side RESTORABLE_FIELDS allowlist
 *
 * Restore calls POST /api/transactions/:id/revisions/:rid/restore and the
 * server records a new source='restore' revision so the timeline shows
 * the round-trip (no silent history rewriting).
 *
 * Designed to mirror EnrichmentSignalsDialog so the surrounding page can
 * own the controlled state (open/close, refresh on success).
 */

export type RevisionedFieldChange = {
  field: string
  before: unknown
  after: unknown
}

export type TransactionRevisionEntry = {
  id: number
  transactionId: number
  source: string
  changedByUserId: number | null
  aiSuggestionId: number | null
  changes: RevisionedFieldChange[]
  createdAt: string
}

type Props = {
  transactionId: number | null
  onClose: () => void
  /** Called after a successful restore so the parent can refresh the row. */
  onRestored?: (updated: Transaction) => void
}

// Mirror of backend RESTORABLE_FIELDS — only these will show a Restore CTA.
// Kept in sync with backend/src/util/transactionRevisions.ts (the server
// re-validates, so this just guides UX).
const RESTORABLE_FIELDS = new Set([
  'categoryOverride',
  'businessOverride',
  'splitOverride',
  'pctMeOverride',
  'pctPartnerOverride',
  'notes',
  'reviewFlag',
])

const SOURCE_VARIANT: Record<
  string,
  'default' | 'secondary' | 'outline' | 'destructive'
> = {
  user_edit: 'default',
  bulk_patch: 'secondary',
  ai_suggestion: 'default',
  refund_link: 'secondary',
  import: 'outline',
  enrichment: 'outline',
  restore: 'secondary',
  system: 'outline',
}

const SOURCE_LABEL: Record<string, string> = {
  user_edit: 'edited',
  bulk_patch: 'bulk edit',
  ai_suggestion: 'AI accepted',
  refund_link: 'refund link',
  import: 'imported',
  enrichment: 'enrichment',
  restore: 'restored',
  system: 'system',
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'string' || typeof v === 'number') return String(v)
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

export function TransactionRevisionsDialog({
  transactionId,
  onClose,
  onRestored,
}: Props) {
  const [revisions, setRevisions] = useState<TransactionRevisionEntry[] | null>(
    null,
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [restoringId, setRestoringId] = useState<number | null>(null)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)

  useEffect(() => {
    if (transactionId == null) {
      setRevisions(null)
      setError(null)
      setStatusMsg(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    getJson<{ data: TransactionRevisionEntry[] }>(
      `/api/transactions/${transactionId}/revisions`,
    )
      .then((res) => {
        if (!cancelled) setRevisions(res.data)
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to load revisions')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [transactionId])

  async function refreshTimeline() {
    if (transactionId == null) return
    const res = await getJson<{ data: TransactionRevisionEntry[] }>(
      `/api/transactions/${transactionId}/revisions`,
    )
    setRevisions(res.data)
  }

  async function restoreRevision(entry: TransactionRevisionEntry) {
    if (transactionId == null || restoringId != null) return
    const restorableFields = entry.changes
      .map((c) => c.field)
      .filter((f) => RESTORABLE_FIELDS.has(f))
    if (restorableFields.length === 0) return
    setRestoringId(entry.id)
    setError(null)
    setStatusMsg(null)
    try {
      const res = await postJson<{
        transaction: Transaction
        restored: Array<{ field: string; restoredTo: unknown }>
      }>(`/api/transactions/${transactionId}/revisions/${entry.id}/restore`, {})
      onRestored?.(res.transaction)
      setStatusMsg(
        `Restored ${res.restored.length} field${
          res.restored.length === 1 ? '' : 's'
        }`,
      )
      await refreshTimeline()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Restore failed')
    } finally {
      setRestoringId(null)
    }
  }

  const open = transactionId != null

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
    >
      <DialogHeader>
        <DialogTitle>Edit history</DialogTitle>
      </DialogHeader>
      <DialogBody>
        {loading && <p className="muted">Loading history…</p>}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {statusMsg && (
          <p className="muted" role="status">
            {statusMsg}
          </p>
        )}
        {!loading && !error && revisions && revisions.length === 0 && (
          <p className="muted">
            No edits recorded for this transaction yet. Edits made from now on
            will appear here.
          </p>
        )}
        {revisions && revisions.length > 0 && (
          <ol style={{ paddingLeft: '1.25rem', margin: 0 }}>
            {revisions.map((rev) => {
              const restorableFields = rev.changes.filter((c) =>
                RESTORABLE_FIELDS.has(c.field),
              )
              return (
                <li key={rev.id} style={{ marginBottom: '0.75rem' }}>
                  <div className="row" style={{ gap: '0.4rem', flexWrap: 'wrap', alignItems: 'center' }}>
                    <Badge variant={SOURCE_VARIANT[rev.source] ?? 'outline'}>
                      {SOURCE_LABEL[rev.source] ?? rev.source}
                    </Badge>
                    <span className="muted" style={{ fontSize: '0.8rem' }}>
                      {formatTimestamp(rev.createdAt)}
                    </span>
                    {rev.aiSuggestionId != null && (
                      <span className="muted" style={{ fontSize: '0.8rem' }}>
                        · AI suggestion #{rev.aiSuggestionId}
                      </span>
                    )}
                  </div>
                  <ul style={{ marginTop: '0.25rem', paddingLeft: '1rem' }}>
                    {rev.changes.map((c) => (
                      <li key={c.field} style={{ fontSize: '0.85rem' }}>
                        <code>{c.field}</code>: {formatValue(c.before)} →{' '}
                        {formatValue(c.after)}
                      </li>
                    ))}
                  </ul>
                  {restorableFields.length > 0 && (
                    <div style={{ marginTop: '0.35rem' }}>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={restoringId != null}
                        onClick={() => void restoreRevision(rev)}
                        title={`Restore the prior value of ${restorableFields
                          .map((c) => c.field)
                          .join(', ')}`}
                      >
                        {restoringId === rev.id ? 'Restoring…' : 'Restore'}
                      </Button>
                    </div>
                  )}
                </li>
              )
            })}
          </ol>
        )}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Close
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
