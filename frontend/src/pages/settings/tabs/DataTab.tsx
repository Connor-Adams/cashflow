import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { useToast } from '@/components/ui/toast'
import { getJson, postJson } from '../../../lib/api'

/** Shape returned by GET /api/me/exports */
type ExportRow = {
  id: number
  status: 'queued' | 'running' | 'ready' | 'failed'
  requestedAt: string
  readyAt: string | null
  expiresAt: string | null
  byteSize: number | null
  errorMessage: string | null
}

type ExportsResponse = { exports: ExportRow[] }

type RequestExportResponse = { exportId: number; status: string }

const POLL_INTERVAL_MS = 5_000

function statusVariant(status: ExportRow['status']): 'secondary' | 'outline' | 'default' | 'destructive' {
  switch (status) {
    case 'queued':
      return 'secondary'
    case 'running':
      return 'secondary'
    case 'ready':
      return 'default'
    case 'failed':
      return 'destructive'
  }
}

function statusLabel(status: ExportRow['status']): string {
  switch (status) {
    case 'queued':
      return 'Queued'
    case 'running':
      return 'Preparing…'
    case 'ready':
      return 'Ready'
    case 'failed':
      return 'Failed'
  }
}

function daysUntil(iso: string): number {
  const ms = new Date(iso).getTime() - Date.now()
  return Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)))
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Settings → Data tab (issue #302).
 *
 * Shows the user's data export history and lets them request a new backup.
 * Polls every 5 s while any export is in a non-terminal state (queued or
 * running), then clears the interval once all are settled.
 */
export function DataTab() {
  const { showToast } = useToast()
  const [rows, setRows] = useState<ExportRow[]>([])
  const [loading, setLoading] = useState(true)
  const [requesting, setRequesting] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const prevReadyIds = useRef<Set<number>>(new Set())
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await getJson<ExportsResponse>('/api/me/exports')
      setRows(res.exports)

      // Detect newly-ready exports (status transitioned to 'ready' since last poll).
      const newlyReady = res.exports.filter(
        (r) => r.status === 'ready' && !prevReadyIds.current.has(r.id),
      )
      if (newlyReady.length > 0) {
        showToast({ title: 'Your export is ready to download.' })
      }
      prevReadyIds.current = new Set(
        res.exports.filter((r) => r.status === 'ready').map((r) => r.id),
      )
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load exports')
    } finally {
      setLoading(false)
    }
  }, [showToast])

  // Start/stop polling based on whether any export is in flight.
  useEffect(() => {
    const inFlight = rows.some((r) => r.status === 'queued' || r.status === 'running')

    if (inFlight && !pollRef.current) {
      pollRef.current = setInterval(() => {
        void load()
      }, POLL_INTERVAL_MS)
    } else if (!inFlight && pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [rows, load])

  // Clear interval on unmount.
  useEffect(() => {
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function requestExport() {
    setRequesting(true)
    try {
      await postJson<RequestExportResponse>('/api/me/export')
      showToast({ title: 'Export started. We will notify you when it is ready.' })
      await load()
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not start export'
      if (msg === 'EXPORT_IN_FLIGHT') {
        showToast({ title: 'An export is already in progress.', variant: 'destructive' })
      } else {
        showToast({ title: msg, variant: 'destructive' })
      }
    } finally {
      setRequesting(false)
    }
  }

  const hasInFlight = rows.some((r) => r.status === 'queued' || r.status === 'running')

  return (
    <>
      <Card className="accountsFormCard">
        <div className="accountsCardHeader">
          <div>
            <h2>Data export</h2>
            <p className="muted">
              Download a full backup of your Cashflow data as a compressed JSON file.
            </p>
          </div>
          <Button
            type="button"
            onClick={() => void requestExport()}
            disabled={requesting || hasInFlight}
          >
            {requesting || hasInFlight ? 'Preparing…' : 'Request a backup'}
          </Button>
        </div>
      </Card>

      {loading ? (
        <Card aria-busy="true">
          <p className="muted">Loading…</p>
        </Card>
      ) : err ? (
        <span className="error" role="alert">
          {err}
        </span>
      ) : rows.length === 0 ? (
        <EmptyState
          className="text-center"
          title="You have not exported your data yet. Press the button to request a backup."
        />
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((row) => (
            <Card key={row.id} className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Badge variant={statusVariant(row.status)}>
                    {statusLabel(row.status)}
                  </Badge>
                  {row.status === 'ready' && row.expiresAt && (
                    <span className="muted text-xs">
                      Expires in {daysUntil(row.expiresAt)} day{daysUntil(row.expiresAt) === 1 ? '' : 's'}
                    </span>
                  )}
                  {row.status === 'running' && (
                    <span className="muted text-xs">Preparing…</span>
                  )}
                  {row.status === 'failed' && row.errorMessage && (
                    <span className="muted text-xs text-red-500">
                      Failed: {row.errorMessage}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {row.byteSize != null && (
                    <span className="muted text-xs">{formatBytes(row.byteSize)}</span>
                  )}
                  <span className="muted text-xs">
                    {new Date(row.requestedAt).toLocaleDateString()}
                  </span>
                  {row.status === 'ready' && (
                    <a
                      href={`/api/me/export/${row.id}/download`}
                      download
                    >
                      <Button type="button" size="sm" variant="outline">
                        Download
                      </Button>
                    </a>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  )
}
