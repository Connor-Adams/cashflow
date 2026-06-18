import { useEffect, useRef, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { useConfirm } from '@/components/ui/dialog'
import type {
  CounterpartyBackfillProgress,
  CounterpartyBackfillStatus,
} from '@cashflow/shared'

type SummaryEvent = Extract<CounterpartyBackfillProgress, { kind: 'summary' }>
type ProgressEvent = Extract<CounterpartyBackfillProgress, { kind: 'progress' }>
type ErrorEvent = Extract<CounterpartyBackfillProgress, { kind: 'error' }>

const MAX_FEED_ROWS = 200

function formatRemaining(ms: number): string {
  if (ms <= 0) return 'available now'
  const totalMin = Math.ceil(ms / 60000)
  if (totalMin >= 60) {
    const h = Math.floor(totalMin / 60)
    const m = totalMin % 60
    return m > 0 ? `${h}h ${m}m` : `${h}h`
  }
  return `${totalMin}m`
}

/**
 * Settings UI control for the retroactive counterparty backfill (issue #376).
 *
 * The button kicks off a server-side sweep that re-runs the import
 * `extractCounterparty` over legacy transactions on checking/savings/cash
 * accounts where `counterparty_raw` is still NULL. Streams progress events
 * over NDJSON so the user can watch the run finish; rate-limited to once
 * per hour per household by the backend.
 */
export function CounterpartyBackfillCard() {
  const [status, setStatus] = useState<CounterpartyBackfillStatus | null>(null)
  const [statusLoading, setStatusLoading] = useState<boolean>(true)
  const [running, setRunning] = useState<boolean>(false)
  const [summary, setSummary] = useState<SummaryEvent | null>(null)
  const [feed, setFeed] = useState<ProgressEvent[]>([])
  const [errors, setErrors] = useState<ErrorEvent[]>([])
  const [live, setLive] = useState<{ processed: number; extracted: number; skipped: number } | null>(
    null,
  )
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  // For ticking down the rate-limit countdown without re-fetching status.
  const [tick, setTick] = useState<number>(0)
  const mountedRef = useRef<boolean>(true)
  const confirm = useConfirm()

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  async function loadStatus() {
    setStatusLoading(true)
    try {
      const base = (import.meta as unknown as { env: { VITE_API_BASE?: string } }).env?.VITE_API_BASE ?? ''
      const res = await fetch(`${base}/api/transactions/counterparty/backfill/status`, {
        credentials: 'include',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = (await res.json()) as CounterpartyBackfillStatus
      if (mountedRef.current) setStatus(body)
    } catch (e) {
      if (mountedRef.current) setErrorMessage(e instanceof Error ? e.message : 'Failed to load status')
    } finally {
      if (mountedRef.current) setStatusLoading(false)
    }
  }

  useEffect(() => {
    void loadStatus()
  }, [])

  // Re-render once a minute so the rate-limit countdown stays fresh.
  useEffect(() => {
    if (!status?.nextAllowedAt) return
    const t = setInterval(() => setTick((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [status?.nextAllowedAt])

  const now = Date.now()
  const nextAllowedAtMs = status?.nextAllowedAt ? new Date(status.nextAllowedAt).getTime() : null
  const rateLimited = nextAllowedAtMs != null && nextAllowedAtMs > now
  const buttonDisabled = statusLoading || running || (status?.running ?? false) || rateLimited

  async function startBackfill() {
    if (buttonDisabled) return
    const ok = await confirm({
      title: 'Backfill counterparty on past imports?',
      description:
        'Re-runs the counterparty extractor over every checking, savings, and cash transaction in your household that does not yet have a counterparty. Rows that already have a counterparty (manual edits, future imports) are not touched. Rate-limited to once per hour.',
      confirmLabel: 'Run backfill',
    })
    if (!ok) return

    setRunning(true)
    setSummary(null)
    setErrors([])
    setFeed([])
    setErrorMessage(null)
    setLive({ processed: 0, extracted: 0, skipped: 0 })

    try {
      const base = (import.meta as unknown as { env: { VITE_API_BASE?: string } }).env?.VITE_API_BASE ?? ''
      const res = await fetch(`${base}/api/transactions/counterparty/backfill?stream=1`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/x-ndjson',
        },
        body: JSON.stringify({}),
      })
      if (res.status === 429) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string
          nextAllowedAt?: string
        }
        setErrorMessage(body.error ?? 'Rate-limited.')
        if (body.nextAllowedAt && status) {
          setStatus({ ...status, nextAllowedAt: body.nextAllowedAt })
        }
        return
      }
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => res.statusText)
        throw new Error(text || `HTTP ${res.status}`)
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let processed = 0
      let extracted = 0
      let skipped = 0
      let liveFeed: ProgressEvent[] = []
      let liveErrors: ErrorEvent[] = []
      let lastFlush = Date.now()

      const flush = () => {
        if (!mountedRef.current) return
        setFeed(liveFeed.slice())
        setErrors(liveErrors.slice())
        setLive({ processed, extracted, skipped })
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
          let event: CounterpartyBackfillProgress
          try {
            event = JSON.parse(line) as CounterpartyBackfillProgress
          } catch {
            continue
          }
          if (event.kind === 'progress') {
            processed += 1
            if (event.counterpartyRaw != null) extracted += 1
            liveFeed = [event, ...liveFeed].slice(0, MAX_FEED_ROWS)
          } else if (event.kind === 'error') {
            skipped += 1
            liveErrors = [event, ...liveErrors].slice(0, 50)
          } else if (event.kind === 'summary') {
            if (mountedRef.current) setSummary(event)
          }
          if (Date.now() - lastFlush > 100) flush()
        }
      }
      flush()
      // After completion, reload the status so the rate-limit clock + last-run
      // summary are reflected in the UI.
      await loadStatus()
    } catch (e) {
      if (mountedRef.current) {
        setErrorMessage(e instanceof Error ? e.message : 'Counterparty backfill failed')
      }
    } finally {
      if (mountedRef.current) setRunning(false)
    }
  }

  return (
    <>
      <Card>
        <div className="flex items-baseline justify-between gap-3 mb-2">
          <div>
            <h2 className="text-base font-semibold m-0">Backfill counterparty on past imports</h2>
            <p className="muted text-sm mt-1 mb-0">
              Re-runs the counterparty extractor over every checking, savings, and cash transaction that
              does not yet have a counterparty. Useful after importing legacy statements predating the
              counterparty feature. Manual edits and rows with a counterparty already set are never
              overwritten.
            </p>
          </div>
          <span className="bg-[var(--accent)] text-[var(--accent-foreground)] px-[10px] py-[2px] rounded-full text-[0.7rem] font-semibold tracking-[0.04em] whitespace-nowrap">Admin action</span>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 mt-3">
          <div className="text-sm muted">
            {statusLoading ? (
              'Loading status…'
            ) : status?.lastRunAt && status.lastSummary ? (
              <>
                Last run on{' '}
                <strong>{new Date(status.lastRunAt).toLocaleString()}</strong> — processed{' '}
                {status.lastSummary.processed}, {status.lastSummary.extracted} counterparties extracted
                ({(status.lastSummary.elapsedMs / 1000).toFixed(1)}s).
              </>
            ) : (
              'No backfill has been run for this household yet.'
            )}
          </div>
          <div className="ml-auto">
            <Button
              type="button"
              disabled={buttonDisabled}
              onClick={() => void startBackfill()}
              aria-label="Backfill counterparty on past imports"
            >
              <Sparkles aria-hidden="true" />
              {running ? 'Running backfill…' : 'Backfill counterparty on past imports'}
            </Button>
          </div>
        </div>
        {rateLimited && nextAllowedAtMs != null && (
          <p className="text-sm mt-2" data-tick={tick}>
            Rate-limited — available again in {formatRemaining(nextAllowedAtMs - now)}.
          </p>
        )}
        {errorMessage && (
          <span className="error mt-2 block" role="alert">
            {errorMessage}
          </span>
        )}
        {(running || live || summary) && (
          <div className="mt-3">
            {summary ? (
              <p>
                <strong>Backfill complete.</strong> Processed {summary.processed}, extracted{' '}
                {summary.extracted}, skipped {summary.skipped}{' '}
                ({(summary.elapsedMs / 1000).toFixed(1)}s).
              </p>
            ) : live ? (
              <p className="muted">
                Streaming… processed {live.processed}, extracted {live.extracted}, skipped {live.skipped}
              </p>
            ) : null}
            {errors.length > 0 && (
              <details className="mt-1">
                <summary className="error">{errors.length} row(s) failed</summary>
                <ul className="text-xs mt-1">
                  {errors.slice(0, 20).map((e, i) => (
                    <li key={i}>
                      txn {e.txnId ?? '?'}: {e.message}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {feed.length > 0 && (
              <div
                className="mt-2 max-h-[18rem] overflow-y-auto border-t border-[var(--border)] pt-2 text-[0.78rem] leading-[1.3] font-mono"
                role="log"
                aria-live="polite"
              >
                {feed.map((row) => (
                  <div key={row.txnId} className="flex gap-2 items-baseline">
                    <span className="muted w-[4rem] text-right">#{row.txnId}</span>
                    <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{row.merchantRaw}</span>
                    {row.counterpartyRaw ? (
                      <span>
                        → <strong>{row.counterpartyRaw}</strong>
                      </span>
                    ) : (
                      <span className="muted">— no pattern matched</span>
                    )}
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
