import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { getJson, postJson } from '../lib/api'
import type { EnrichmentSignal, Transaction } from '../types/api'

type Props = {
  transactionId: number | null
  /** Optional summary of the underlying transaction for context. */
  transactionSummary?: {
    merchantRaw: string
    merchantClean: string
    merchantCanonical: string | null
    autoSource: string | null
    autoConfidence: string | null
    autoCategory: string | null
    txnType: string
    reviewFlag: boolean
    isRecurring: boolean
  } | null
  onClose: () => void
  /** Called after a successful re-enrich so the parent can refresh its row. */
  onReenriched?: (updated: Transaction) => void
}

const CONFIDENCE_VARIANT: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  high: 'default',
  medium: 'secondary',
  low: 'outline',
}

export function EnrichmentSignalsDialog({
  transactionId,
  transactionSummary,
  onClose,
  onReenriched,
}: Props) {
  const [signals, setSignals] = useState<EnrichmentSignal[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reenriching, setReenriching] = useState(false)

  useEffect(() => {
    if (transactionId == null) {
      setSignals(null)
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    getJson<EnrichmentSignal[]>(`/api/transactions/${transactionId}/signals`)
      .then((rows) => {
        if (!cancelled) setSignals(rows)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load signals')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [transactionId])

  async function reenrich() {
    if (transactionId == null || reenriching) return
    setReenriching(true)
    setError(null)
    try {
      // Run a single-row backfill targeting this txn only. The backfill route
      // is household-scoped; we use limit:1 + the existing route via a small
      // query. For simplicity we just re-fetch signals after a no-op fetch.
      // (A dedicated POST /:id/enrich is a future enhancement.)
      const updated = await postJson<Transaction>(`/api/transactions/${transactionId}/re-enrich`, {})
      onReenriched?.(updated)
      // refresh signals
      const rows = await getJson<EnrichmentSignal[]>(`/api/transactions/${transactionId}/signals`)
      setSignals(rows)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Re-enrich failed')
    } finally {
      setReenriching(false)
    }
  }

  const open = transactionId != null

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogHeader>
        <DialogTitle>Why this transaction was categorised</DialogTitle>
      </DialogHeader>
      <DialogBody>
        {transactionSummary && (
          <div style={{ marginBottom: '0.75rem' }}>
            <div><strong>Raw:</strong> <code>{transactionSummary.merchantRaw}</code></div>
            <div><strong>Cleaned:</strong> <code>{transactionSummary.merchantClean}</code>{transactionSummary.merchantCanonical && <> · <em>{transactionSummary.merchantCanonical}</em></>}</div>
            <div className="row" style={{ gap: '0.35rem', flexWrap: 'wrap', marginTop: '0.35rem' }}>
              <Badge variant="secondary">type: {transactionSummary.txnType}</Badge>
              {transactionSummary.autoSource && (
                <Badge variant="secondary">source: {transactionSummary.autoSource}</Badge>
              )}
              {transactionSummary.autoConfidence && (
                <Badge variant={CONFIDENCE_VARIANT[transactionSummary.autoConfidence] ?? 'muted'}>
                  {transactionSummary.autoConfidence}
                </Badge>
              )}
              <Badge variant={transactionSummary.reviewFlag ? 'destructive' : 'default'}>
                {transactionSummary.reviewFlag ? 'in review' : 'cleared'}
              </Badge>
              {transactionSummary.isRecurring && <Badge variant="secondary">recurring</Badge>}
            </div>
          </div>
        )}

        {loading && <p className="muted">Loading signals…</p>}
        {error && <p className="error" role="alert">{error}</p>}
        {!loading && !error && signals && signals.length === 0 && (
          <p className="muted">No enrichment signals recorded for this transaction yet.</p>
        )}
        {signals && signals.length > 0 && (
          <ol style={{ paddingLeft: '1.25rem', margin: 0 }}>
            {signals.map((s) => (
              <li key={s.id} style={{ marginBottom: '0.5rem' }}>
                <div className="row" style={{ gap: '0.35rem', flexWrap: 'wrap' }}>
                  <Badge variant="secondary">{s.source}</Badge>
                  <Badge variant={CONFIDENCE_VARIANT[s.confidence] ?? 'muted'}>
                    {s.confidence}
                  </Badge>
                </div>
                {s.rationale && <div className="muted" style={{ marginTop: '0.2rem' }}>{s.rationale}</div>}
                {Object.keys(s.fields).length > 0 && (
                  <details style={{ marginTop: '0.2rem' }}>
                    <summary className="muted" style={{ cursor: 'pointer' }}>fields ({Object.keys(s.fields).length})</summary>
                    <pre style={{ fontSize: '0.75rem', whiteSpace: 'pre-wrap', marginTop: '0.25rem' }}>
                      {JSON.stringify(s.fields, null, 2)}
                    </pre>
                  </details>
                )}
              </li>
            ))}
          </ol>
        )}
      </DialogBody>
      <DialogFooter>
        {onReenriched && (
          <Button
            type="button"
            variant="secondary"
            disabled={reenriching || loading}
            onClick={() => void reenrich()}
          >
            <RefreshCw aria-hidden="true" />
            {reenriching ? 'Re-enriching…' : 'Re-enrich this row'}
          </Button>
        )}
        <Button type="button" variant="outline" onClick={onClose}>
          Close
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
