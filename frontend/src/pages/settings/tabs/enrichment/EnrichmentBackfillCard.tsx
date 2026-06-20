import { useState } from 'react'
import { Sparkles } from 'lucide-react'
import { Button } from '@connor-adams/designsystem'
import { Card } from '@connor-adams/designsystem'
import { useConfirm } from '@/lib/ds-extras'
import { Input } from '@connor-adams/designsystem'
import { Label } from '@connor-adams/designsystem'
import type { EnrichmentBackfillProgress } from '../../../../types/api'

type BackfillSummary = Extract<EnrichmentBackfillProgress, { kind: 'summary' }>
type BackfillProgressRow = Extract<EnrichmentBackfillProgress, { kind: 'progress' }>
type BackfillErrorEvent = Extract<EnrichmentBackfillProgress, { kind: 'error' }>

const MAX_FEED_ROWS = 200

type Props = {
  /** Called when a real (non-dry) backfill finishes successfully so the parent can refresh stats. */
  onComplete: () => void
}

export function EnrichmentBackfillCard({ onComplete }: Props) {
  const [backfillRunning, setBackfillRunning] = useState<'dry' | 'real' | null>(null)
  const [backfillSummary, setBackfillSummary] = useState<BackfillSummary | null>(null)
  const [backfillError, setBackfillError] = useState<string | null>(null)
  const [backfillFeed, setBackfillFeed] = useState<BackfillProgressRow[]>([])
  const [backfillErrors, setBackfillErrors] = useState<BackfillErrorEvent[]>([])
  const [backfillLive, setBackfillLive] = useState<{ processed: number; cleared: number; skipped: number } | null>(null)
  const [backfillClearReview, setBackfillClearReview] = useState(true)
  const [backfillReviewOnly, setBackfillReviewOnly] = useState(false)
  const [backfillLimit, setBackfillLimit] = useState('')

  const confirm = useConfirm()

  async function runBackfill(mode: 'dry' | 'real') {
    if (backfillRunning) return
    if (mode === 'real') {
      const ok = await confirm({
        title: 'Run enrichment backfill?',
        description:
          'Re-runs the import enrichment pipeline against every transaction in your household. Override fields and already-reviewed rows are untouched.',
        confirmLabel: 'Run backfill',
      })
      if (!ok) return
    }
    setBackfillRunning(mode)
    setBackfillError(null)
    setBackfillSummary(null)
    setBackfillFeed([])
    setBackfillErrors([])
    setBackfillLive({ processed: 0, cleared: 0, skipped: 0 })

    const limit = Number(backfillLimit.trim())
    const body: Record<string, unknown> = {
      dryRun: mode === 'dry',
      noReviewFlag: !backfillClearReview,
      reviewOnly: backfillReviewOnly,
    }
    if (Number.isFinite(limit) && limit > 0) body.limit = Math.floor(limit)

    try {
      const base = import.meta.env.VITE_API_BASE ?? ''
      const res = await fetch(`${base}/api/transactions/enrichment/backfill?stream=1`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/x-ndjson',
        },
        body: JSON.stringify(body),
      })
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => res.statusText)
        throw new Error(text || `HTTP ${res.status}`)
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let processed = 0
      let cleared = 0
      let skipped = 0
      let liveFeed: BackfillProgressRow[] = []
      let liveErrors: BackfillErrorEvent[] = []
      // Throttle React updates: only flush once per ~100ms
      let lastFlush = Date.now()
      const flush = () => {
        setBackfillFeed(liveFeed.slice())
        setBackfillErrors(liveErrors.slice())
        setBackfillLive({ processed, cleared, skipped })
        lastFlush = Date.now()
      }
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let nl = buffer.indexOf('\n')
        while (nl !== -1) {
          const line = buffer.slice(0, nl).trim()
          buffer = buffer.slice(nl + 1)
          nl = buffer.indexOf('\n')
          if (!line) continue
          let event: EnrichmentBackfillProgress
          try {
            event = JSON.parse(line) as EnrichmentBackfillProgress
          } catch {
            continue
          }
          if (event.kind === 'progress') {
            processed++
            if (event.reviewFlagCleared) cleared++
            liveFeed = [event, ...liveFeed].slice(0, MAX_FEED_ROWS)
          } else if (event.kind === 'error') {
            skipped++
            liveErrors = [event, ...liveErrors].slice(0, 50)
          } else if (event.kind === 'summary') {
            setBackfillSummary(event)
          }
          if (Date.now() - lastFlush > 100) flush()
        }
      }
      flush()
      if (mode === 'real') onComplete()
    } catch (e) {
      setBackfillError(e instanceof Error ? e.message : 'Backfill failed')
    } finally {
      setBackfillRunning(null)
    }
  }

  return (
    <>
      <Card>
        <div className="flex items-baseline justify-between gap-3 mb-2">
          <div>
            <h2 className="text-base font-semibold m-0">Backfill enrichment</h2>
            <p className="muted text-sm mt-1 mb-0">
              Re-runs the import enrichment pipeline against every transaction in your household. Override fields and
              already-reviewed rows are never touched.
            </p>
          </div>
          <span className="bg-[var(--accent)] text-[var(--accent-foreground)] px-[10px] py-[2px] rounded-full text-[0.7rem] font-semibold tracking-[0.04em] whitespace-nowrap">Admin action</span>
        </div>
        <div className="flex flex-wrap items-center gap-3 mt-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={backfillClearReview}
              onChange={(e) => setBackfillClearReview(e.target.checked)}
              disabled={backfillRunning != null}
            />
            Clear review flag on rows the pipeline can now confidently categorise
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={backfillReviewOnly}
              onChange={(e) => setBackfillReviewOnly(e.target.checked)}
              disabled={backfillRunning != null}
            />
            Only re-process rows currently in review
          </label>
          <Label htmlFor="settings-backfill-limit" className="text-sm m-0">
            <span className="sr-only">Row limit</span>
            <Input
              id="settings-backfill-limit"
              type="number"
              min={1}
              placeholder="all rows"
              value={backfillLimit}
              onChange={(e) => setBackfillLimit(e.target.value)}
              disabled={backfillRunning != null}
              className="w-32"
            />
          </Label>
          <div className="ml-auto flex gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={backfillRunning != null}
              onClick={() => void runBackfill('dry')}
            >
              <Sparkles aria-hidden="true" />
              {backfillRunning === 'dry' ? 'Running dry run…' : 'Dry run'}
            </Button>
            <Button
              type="button"
              disabled={backfillRunning != null}
              onClick={() => void runBackfill('real')}
            >
              <Sparkles aria-hidden="true" />
              {backfillRunning === 'real' ? 'Running backfill…' : 'Run backfill'}
            </Button>
          </div>
        </div>
        {backfillError && (
          <span className="error mt-2 block" role="alert">
            {backfillError}
          </span>
        )}
        {(backfillRunning || backfillLive || backfillSummary) && (
          <div className="mt-3">
            {backfillSummary ? (
              <p>
                <strong>
                  {backfillSummary.dryRun ? 'Dry run — no changes written.' : 'Backfill complete.'}
                </strong>{' '}
                Processed {backfillSummary.processed}, updated {backfillSummary.updated}, review flag cleared on{' '}
                {backfillSummary.reviewFlagCleared}, signals written {backfillSummary.signalsWritten}, skipped{' '}
                {backfillSummary.skipped} ({(backfillSummary.durationMs / 1000).toFixed(1)}s).
              </p>
            ) : backfillLive ? (
              <p className="muted">
                Streaming… processed {backfillLive.processed}, cleared {backfillLive.cleared}, skipped{' '}
                {backfillLive.skipped}
              </p>
            ) : null}
            {backfillErrors.length > 0 && (
              <details className="mt-1">
                <summary className="error">{backfillErrors.length} row(s) failed</summary>
                <ul className="text-xs mt-1">
                  {backfillErrors.slice(0, 20).map((e, i) => (
                    <li key={i}>txn {e.txnId ?? '?'}: {e.message}</li>
                  ))}
                </ul>
              </details>
            )}
            {backfillFeed.length > 0 && (
              <div
                className="mt-2 max-h-[18rem] overflow-y-auto border-t border-[var(--border)] pt-2 text-[0.78rem] leading-[1.3] font-mono"
                role="log"
                aria-live="polite"
              >
                {backfillFeed.map((row) => (
                  <div key={row.txnId} className="flex gap-2 items-baseline">
                    <span className="muted w-[4rem] text-right">#{row.txnId}</span>
                    <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{row.merchantRaw}</span>
                    <span>
                      → <strong>{row.merchantCanonical ?? row.merchantClean}</strong>
                    </span>
                    <span className="muted min-w-[6rem]">
                      {row.autoSource ?? '—'}/{row.autoConfidence ?? '—'}
                    </span>
                    {row.reviewFlagCleared && <span className="text-[var(--success)]">✓ cleared</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Card>
      {confirm.dialog}
    </>
  )
}
