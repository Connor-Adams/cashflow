import { useEffect, useRef, useState } from 'react'
import { Button } from '@connor-adams/designsystem'
import { Icon } from '@connor-adams/designsystem'
import { Card } from '@connor-adams/designsystem'
import { getJson, postJson } from '@/lib/api'

type SyncSummary = {
  processed: number
  autoApplied: number
  suggested: number
  selfApplied: number
  elapsedMs: number
  dryRun: boolean
}

type SyncStatus = {
  running: boolean
  lastRunAt: string | null
  lastSummary: SyncSummary | null
}

/**
 * Settings UI control for the Interac email counterparty sync (issue #403).
 *
 * Posts to /api/transactions/interac-counterparty/sync and surfaces the
 * returned summary: how many names were auto-applied, self-identified, and
 * queued in the inbox for review.
 */
export function InteracSyncCard() {
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [statusLoading, setStatusLoading] = useState<boolean>(true)
  const [running, setRunning] = useState<boolean>(false)
  const [result, setResult] = useState<SyncSummary | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const mountedRef = useRef<boolean>(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  async function loadStatus() {
    setStatusLoading(true)
    try {
      const body = await getJson<SyncStatus>('/api/transactions/interac-counterparty/status')
      if (mountedRef.current) setStatus(body)
    } catch (e) {
      if (mountedRef.current)
        setErrorMessage(e instanceof Error ? e.message : 'Failed to load status')
    } finally {
      if (mountedRef.current) setStatusLoading(false)
    }
  }

  useEffect(() => {
    void loadStatus()
  }, [])

  const buttonDisabled = statusLoading || running || (status?.running ?? false)

  async function runSync() {
    if (buttonDisabled) return
    setRunning(true)
    setResult(null)
    setErrorMessage(null)
    try {
      const summary = await postJson<SyncSummary>('/api/transactions/interac-counterparty/sync')
      if (mountedRef.current) {
        setResult(summary)
        await loadStatus()
      }
    } catch (e) {
      if (mountedRef.current) {
        setErrorMessage(e instanceof Error ? e.message : 'Interac sync failed')
      }
    } finally {
      if (mountedRef.current) setRunning(false)
    }
  }

  return (
    <Card>
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <div>
          <h2 className="text-base font-semibold m-0">Sync Interac names from email</h2>
          <p className="muted text-sm mt-1 mb-0">
            Scans Interac e-Transfer confirmation emails to identify the names of senders and
            recipients, then links them to matching transactions. High-confidence matches are
            applied automatically; ambiguous matches are queued in the inbox for review.
          </p>
        </div>
        <span className="bg-accent text-accent-foreground px-[10px] py-[2px] rounded-full text-[0.7rem] font-semibold tracking-[0.04em] whitespace-nowrap">Admin action</span>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 mt-3">
        <div className="text-sm muted">
          {statusLoading ? (
            'Loading status…'
          ) : status?.lastRunAt && status.lastSummary ? (
            <>
              Last run on{' '}
              <strong>{new Date(status.lastRunAt).toLocaleString()}</strong> — applied{' '}
              {status.lastSummary.autoApplied}, {status.lastSummary.selfApplied} self,{' '}
              {status.lastSummary.suggested} to review (
              {(status.lastSummary.elapsedMs / 1000).toFixed(1)}s).
            </>
          ) : (
            'No Interac sync has been run for this household yet.'
          )}
        </div>
        <div className="ml-auto">
          <Button
            type="button"
            disabled={buttonDisabled}
            onClick={() => void runSync()}
            aria-label="Sync Interac names from email"
          >
            <Icon name="sparkles" aria-hidden="true" />
            {running ? 'Syncing…' : 'Sync Interac names from email'}
          </Button>
        </div>
      </div>
      {errorMessage && (
        <span className="error mt-2 block" role="alert">
          {errorMessage}
        </span>
      )}
      {result && (
        <p className="mt-2 text-sm">
          <strong>Sync complete.</strong> Applied {result.autoApplied},{' '}
          {result.selfApplied} self, {result.suggested} to review (
          {(result.elapsedMs / 1000).toFixed(1)}s).
        </p>
      )}
    </Card>
  )
}
