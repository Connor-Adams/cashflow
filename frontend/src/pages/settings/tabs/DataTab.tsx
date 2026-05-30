/**
 * Settings → Data tab (issue #302, AC #10, #11).
 *
 * Lists the user's data exports newest-first. Polled every 5 s while any
 * export is in-flight so the status pill updates automatically.
 *
 * States handled:
 *  - Empty: no past exports → CTA copy + Request button.
 *  - In-flight: row shows "Preparing your backup…" pill + elapsed time.
 *  - Ready: row shows "Ready · expires in N days" + Download link.
 *  - Failed: row shows "Failed: <reason>" + Retry button.
 *  - Already in-flight: inline 409 message when user clicks Request.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/toast'
import { getJson, postJson } from '@/lib/api'
import type {
  DataExport,
  DataExportsListResponse,
  RequestDataExportResponse,
} from '@/types/api'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function daysUntil(iso: string): number {
  const ms = new Date(iso).getTime() - Date.now()
  return Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)))
}

function elapsedSince(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(ms / 60_000)
  if (mins < 1) return 'less than a minute'
  if (mins === 1) return '1 minute'
  const hrs = Math.floor(mins / 60)
  if (hrs < 1) return `${mins} minutes`
  if (hrs === 1) return '1 hour'
  return `${hrs} hours`
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ---------------------------------------------------------------------------
// Row component
// ---------------------------------------------------------------------------

type ExportRowProps = {
  row: DataExport
  onRetry: () => void
}

function ExportRow({ row, onRetry }: ExportRowProps) {
  const isInFlight = row.status === 'queued' || row.status === 'running'

  let statusLabel: string
  let statusClass: string
  let actionNode: React.ReactNode = null

  if (row.status === 'ready') {
    const days = row.expiresAt ? daysUntil(row.expiresAt) : 0
    statusLabel = days > 0 ? `Ready · expires in ${days} day${days !== 1 ? 's' : ''}` : 'Expired'
    statusClass = days > 0 ? 'text-emerald-700' : 'text-slate-500'
    if (row.downloadUrl && days > 0) {
      actionNode = (
        <a
          href={row.downloadUrl}
          download
          className="text-sm text-blue-600 hover:underline font-medium"
          data-testid={`download-link-${row.id}`}
        >
          Download
        </a>
      )
    } else if (days === 0) {
      actionNode = (
        <span className="text-sm text-slate-500 italic">
          This export has expired. Request a new one.
        </span>
      )
    }
  } else if (isInFlight) {
    statusLabel = `Preparing your backup… (${elapsedSince(row.requestedAt)})`
    statusClass = 'text-blue-600'
  } else {
    // failed
    statusLabel = `Failed: ${row.errorMessage ?? 'Unknown error'}`
    statusClass = 'text-red-600'
    actionNode = (
      <Button
        variant="outline"
        size="sm"
        onClick={onRetry}
        data-testid={`retry-export-${row.id}`}
      >
        Retry
      </Button>
    )
  }

  const date = new Date(row.requestedAt).toLocaleString()

  return (
    <tr
      className="border-b border-gray-50 last:border-0"
      data-testid={`export-row-${row.id}`}
    >
      <td className="py-3 text-sm text-gray-600">{date}</td>
      <td className={`py-3 text-sm font-medium ${statusClass}`} data-testid={`export-status-${row.id}`}>
        {statusLabel}
      </td>
      <td className="py-3 text-sm text-gray-500">
        {row.byteSize != null ? formatSize(row.byteSize) : '—'}
      </td>
      <td className="py-3 text-right">{actionNode}</td>
    </tr>
  )
}

// ---------------------------------------------------------------------------
// Main tab
// ---------------------------------------------------------------------------

export function DataTab() {
  const [exports, setExports] = useState<DataExport[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [requesting, setRequesting] = useState(false)
  const [inFlightMessage, setInFlightMessage] = useState<string | null>(null)
  const toast = useToast()
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const hasInFlight = exports.some(
    (e) => e.status === 'queued' || e.status === 'running',
  )

  const load = useCallback(async () => {
    try {
      const r = await getJson<DataExportsListResponse>('/api/me/exports')
      setExports(r.data)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load exports')
    } finally {
      setLoading(false)
    }
  }, [])

  // Initial load
  useEffect(() => {
    void load()
  }, [load])

  // Poll while in-flight (AC #10: polled every 5s)
  useEffect(() => {
    if (hasInFlight) {
      pollRef.current = setInterval(() => void load(), 5_000)
    } else {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
  }, [hasInFlight, load])

  const requestExport = useCallback(async () => {
    setRequesting(true)
    setInFlightMessage(null)
    try {
      const r = await postJson<RequestDataExportResponse>('/api/me/export')
      toast.showToast({
        variant: 'default',
        title: 'Export requested',
        description: `Export #${r.exportId} is being prepared. We'll notify you when it's ready.`,
      })
      void load()
    } catch (e) {
      // 409 EXPORT_IN_FLIGHT
      if (e instanceof Error && 'status' in e && (e as { status: number }).status === 409) {
        setInFlightMessage(
          'An export is already being prepared. We will notify you when it is ready.',
        )
      } else {
        toast.showToast({
          variant: 'destructive',
          title: 'Could not start export',
          description: e instanceof Error ? e.message : 'Try again',
        })
      }
    } finally {
      setRequesting(false)
    }
  }, [load, toast])

  const handleRetry = useCallback(async () => {
    setInFlightMessage(null)
    await requestExport()
  }, [requestExport])

  return (
    <Card className="settingsCard">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="settingsCard__title">Your data</h2>
          <p className="settingsCard__description">
            Cashflow stores everything you do here. Download a portable copy anytime.
          </p>
        </div>
        <Button
          onClick={() => void requestExport()}
          disabled={requesting || hasInFlight}
          data-testid="request-export-button"
        >
          {requesting ? 'Requesting…' : 'Request a backup'}
        </Button>
      </div>

      {inFlightMessage && (
        <p
          className="mt-3 text-sm text-amber-700 bg-amber-50 rounded px-3 py-2"
          data-testid="in-flight-message"
        >
          {inFlightMessage}
        </p>
      )}

      {loading && (
        <div data-testid="exports-loading" className="space-y-2 mt-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      )}

      {error && !loading && (
        <div className="mt-4 text-sm text-red-600">
          <p>{error}</p>
          <button
            type="button"
            className="mt-2 text-blue-600 hover:underline"
            onClick={() => void load()}
          >
            Try again
          </button>
        </div>
      )}

      {!loading && !error && exports.length === 0 && (
        <EmptyState
          title="No exports yet"
          description="You have not exported your data yet. Press the button to request a backup."
          data-testid="empty-state"
        />
      )}

      {!loading && !error && exports.length > 0 && (
        <table className="w-full mt-4 text-sm" data-testid="exports-table">
          <thead>
            <tr className="text-left text-gray-500 border-b border-gray-100">
              <th className="py-2">Requested</th>
              <th className="py-2">Status</th>
              <th className="py-2">Size</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {exports.map((row) => (
              <ExportRow key={row.id} row={row} onRetry={() => void handleRetry()} />
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}
