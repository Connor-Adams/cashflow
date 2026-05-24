import { useCallback, useEffect, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { useConfirm } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { getJson } from '../../../lib/api'
import type { EnrichmentBackfillProgress, EnrichmentStats } from '../../../types/api'

type BackfillSummary = Extract<EnrichmentBackfillProgress, { kind: 'summary' }>
type BackfillProgressRow = Extract<EnrichmentBackfillProgress, { kind: 'progress' }>
type BackfillErrorEvent = Extract<EnrichmentBackfillProgress, { kind: 'error' }>

const MAX_FEED_ROWS = 200

export function EnrichmentTab() {
  const [backfillRunning, setBackfillRunning] = useState<'dry' | 'real' | null>(null)
  const [backfillSummary, setBackfillSummary] = useState<BackfillSummary | null>(null)
  const [backfillError, setBackfillError] = useState<string | null>(null)
  const [backfillFeed, setBackfillFeed] = useState<BackfillProgressRow[]>([])
  const [backfillErrors, setBackfillErrors] = useState<BackfillErrorEvent[]>([])
  const [backfillLive, setBackfillLive] = useState<{ processed: number; cleared: number; skipped: number } | null>(null)
  const [backfillClearReview, setBackfillClearReview] = useState(true)
  const [backfillReviewOnly, setBackfillReviewOnly] = useState(false)
  const [backfillLimit, setBackfillLimit] = useState('')
  const [stats, setStats] = useState<EnrichmentStats | null>(null)
  const [statsError, setStatsError] = useState<string | null>(null)
  const [statsLoading, setStatsLoading] = useState(false)

  const confirm = useConfirm()

  const loadStats = useCallback(async () => {
    setStatsLoading(true)
    setStatsError(null)
    try {
      setStats(await getJson<EnrichmentStats>('/api/transactions/enrichment/stats'))
    } catch (e) {
      setStatsError(e instanceof Error ? e.message : 'Could not load stats')
    } finally {
      setStatsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadStats()
  }, [loadStats])

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
      void loadStats()
    } catch (e) {
      setBackfillError(e instanceof Error ? e.message : 'Backfill failed')
    } finally {
      setBackfillRunning(null)
    }
  }

  return (
    <>
      {confirm.dialog}
      <Card className="accountsFormCard">
        <div className="accountsCardHeader">
          <div>
            <h2>Enrichment maintenance</h2>
            <p className="muted">
              Re-runs the import enrichment pipeline against every transaction in your household. Useful after
              normalisation or rule changes. Override fields and already-reviewed rows are never touched.
            </p>
          </div>
        </div>
        <div className="formGrid" style={{ gap: '0.5rem' }}>
          <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={backfillClearReview}
              onChange={(e) => setBackfillClearReview(e.target.checked)}
              disabled={backfillRunning != null}
            />
            Clear review flag on rows the pipeline can now confidently categorise
          </label>
          <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={backfillReviewOnly}
              onChange={(e) => setBackfillReviewOnly(e.target.checked)}
              disabled={backfillRunning != null}
            />
            Only re-process rows currently in review
          </label>
          <Label htmlFor="settings-backfill-limit" style={{ maxWidth: '20rem' }}>
            Row limit (optional, for testing)
            <Input
              id="settings-backfill-limit"
              type="number"
              min={1}
              placeholder="all rows"
              value={backfillLimit}
              onChange={(e) => setBackfillLimit(e.target.value)}
              disabled={backfillRunning != null}
            />
          </Label>
        </div>
        <div className="row" style={{ gap: '0.5rem', marginTop: '0.75rem' }}>
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
        {backfillError && (
          <span className="error" role="alert" style={{ marginTop: '0.5rem' }}>
            {backfillError}
          </span>
        )}
        {(backfillRunning || backfillLive || backfillSummary) && (
          <div style={{ marginTop: '0.75rem' }}>
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
              <details style={{ marginTop: '0.25rem' }}>
                <summary className="error">{backfillErrors.length} row(s) failed</summary>
                <ul style={{ fontSize: '0.8rem', marginTop: '0.25rem' }}>
                  {backfillErrors.slice(0, 20).map((e, i) => (
                    <li key={i}>txn {e.txnId ?? '?'}: {e.message}</li>
                  ))}
                </ul>
              </details>
            )}
            {backfillFeed.length > 0 && (
              <div
                style={{
                  marginTop: '0.5rem',
                  maxHeight: '18rem',
                  overflowY: 'auto',
                  borderTop: '1px solid var(--border)',
                  paddingTop: '0.5rem',
                  fontSize: '0.78rem',
                  lineHeight: 1.3,
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                }}
                role="log"
                aria-live="polite"
              >
                {backfillFeed.map((row) => (
                  <div key={row.txnId} style={{ display: 'flex', gap: '0.5rem', alignItems: 'baseline' }}>
                    <span className="muted" style={{ width: '4rem', textAlign: 'right' }}>#{row.txnId}</span>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {row.merchantRaw}
                    </span>
                    <span>
                      → <strong>{row.merchantCanonical ?? row.merchantClean}</strong>
                    </span>
                    <span className="muted" style={{ minWidth: '6rem' }}>
                      {row.autoSource ?? '—'}/{row.autoConfidence ?? '—'}
                    </span>
                    {row.reviewFlagCleared && <span style={{ color: 'var(--success, green)' }}>✓ cleared</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Card>

      <Card className="accountsFormCard">
        <div className="accountsCardHeader">
          <div>
            <h2>Enrichment dashboard</h2>
            <p className="muted">
              How the pipeline has labelled your household&apos;s transactions.
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" disabled={statsLoading} onClick={() => void loadStats()}>
            Refresh
          </Button>
        </div>
        {statsError && <span className="error" role="alert">{statsError}</span>}
        {statsLoading && !stats && <p className="muted">Loading…</p>}
        {stats && (
          <div style={{ display: 'grid', gap: '0.75rem' }}>
            <div className="row" style={{ gap: '1.5rem', flexWrap: 'wrap' }}>
              <div>
                <div className="muted" style={{ fontSize: '0.75rem' }}>Total transactions</div>
                <div style={{ fontSize: '1.4rem', fontWeight: 600 }}>{stats.total.toLocaleString()}</div>
              </div>
              <div>
                <div className="muted" style={{ fontSize: '0.75rem' }}>In review</div>
                <div style={{ fontSize: '1.4rem', fontWeight: 600 }}>
                  {stats.reviewFlagTrue.toLocaleString()}{' '}
                  <span className="muted" style={{ fontSize: '0.8rem', fontWeight: 400 }}>
                    ({stats.total ? Math.round((stats.reviewFlagTrue / stats.total) * 100) : 0}%)
                  </span>
                </div>
              </div>
              <div>
                <div className="muted" style={{ fontSize: '0.75rem' }}>Cleared</div>
                <div style={{ fontSize: '1.4rem', fontWeight: 600 }}>{stats.reviewFlagFalse.toLocaleString()}</div>
              </div>
              <div>
                <div className="muted" style={{ fontSize: '0.75rem' }}>Recurring</div>
                <div style={{ fontSize: '1.4rem', fontWeight: 600 }}>{stats.isRecurringCount.toLocaleString()}</div>
              </div>
              <div>
                <div className="muted" style={{ fontSize: '0.75rem' }}>Refunds linked</div>
                <div style={{ fontSize: '1.4rem', fontWeight: 600 }}>{stats.refundLinkedCount.toLocaleString()}</div>
              </div>
              <div>
                <div className="muted" style={{ fontSize: '0.75rem' }}>Transfers linked</div>
                <div style={{ fontSize: '1.4rem', fontWeight: 600 }}>{stats.transferLinkedCount.toLocaleString()}</div>
              </div>
            </div>

            <div className="row" style={{ gap: '2rem', flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <div style={{ minWidth: '12rem' }}>
                <h3 style={{ marginBottom: '0.25rem' }}>By source</h3>
                <ul style={{ fontSize: '0.85rem', margin: 0, paddingLeft: '1rem' }}>
                  {Object.entries(stats.bySource)
                    .sort((a, b) => b[1] - a[1])
                    .map(([k, v]) => (
                      <li key={k}>
                        <code>{k}</code>: {v.toLocaleString()}
                      </li>
                    ))}
                </ul>
              </div>
              <div style={{ minWidth: '12rem' }}>
                <h3 style={{ marginBottom: '0.25rem' }}>By confidence</h3>
                <ul style={{ fontSize: '0.85rem', margin: 0, paddingLeft: '1rem' }}>
                  {Object.entries(stats.byConfidence)
                    .sort((a, b) => b[1] - a[1])
                    .map(([k, v]) => (
                      <li key={k}>
                        <code>{k}</code>: {v.toLocaleString()}
                      </li>
                    ))}
                </ul>
              </div>
              <div style={{ minWidth: '12rem' }}>
                <h3 style={{ marginBottom: '0.25rem' }}>By type</h3>
                <ul style={{ fontSize: '0.85rem', margin: 0, paddingLeft: '1rem' }}>
                  {Object.entries(stats.byTxnType)
                    .sort((a, b) => b[1] - a[1])
                    .map(([k, v]) => (
                      <li key={k}>
                        <code>{k}</code>: {v.toLocaleString()}
                      </li>
                    ))}
                </ul>
              </div>
            </div>

            <div className="row" style={{ gap: '2rem', flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <div style={{ minWidth: '16rem', flex: 1 }}>
                <h3 style={{ marginBottom: '0.25rem' }}>Top canonical merchants</h3>
                {stats.topCanonicalMerchants.length === 0 ? (
                  <p className="muted" style={{ fontSize: '0.85rem' }}>
                    None yet. Run the backfill to populate.
                  </p>
                ) : (
                  <ul style={{ fontSize: '0.85rem', margin: 0, paddingLeft: '1rem' }}>
                    {stats.topCanonicalMerchants.map((m) => (
                      <li key={m.name}>
                        {m.name}: {m.count.toLocaleString()}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div style={{ minWidth: '16rem', flex: 1 }}>
                <h3 style={{ marginBottom: '0.25rem' }}>Top firing rules</h3>
                {stats.topRules.length === 0 ? (
                  <p className="muted" style={{ fontSize: '0.85rem' }}>
                    No rule matches recorded yet.
                  </p>
                ) : (
                  <ul style={{ fontSize: '0.85rem', margin: 0, paddingLeft: '1rem' }}>
                    {stats.topRules.map((r) => (
                      <li key={r.ruleId}>
                        <code>{r.pattern}</code> → {r.category ?? '(no category)'} · {r.count.toLocaleString()}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        )}
      </Card>
    </>
  )
}
