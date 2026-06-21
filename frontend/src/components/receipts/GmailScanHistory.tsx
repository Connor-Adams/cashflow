import { useEffect, useState } from 'react'
import { getJson } from '@/lib/api'

type ScanHistoryRow = {
  messageId: string
  subject: string | null
  fromAddr: string | null
  status: string
  parser: string | null
  externalOrderId: number | null
  errorMessage: string | null
  scannedAt: string | null
}

const STATUS_LABEL: Record<string, string> = {
  extracted: 'extracted',
  filtered_subject: 'filtered',
  no_items: 'no items',
  extraction_failed: 'failed',
  duplicate: 'duplicate',
}

export function GmailScanHistory() {
  const [rows, setRows] = useState<ScanHistoryRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const data = await getJson<ScanHistoryRow[]>('/api/email/history')
        if (!cancelled) setRows(data)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load scan history')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <details className="rounded-md border border-border p-3">
      <summary className="cursor-pointer text-sm font-semibold">
        Scan history{rows ? ` (${rows.length})` : ''}
      </summary>
      {error ? (
        <p className="error mt-2 text-sm" role="alert">
          {error}
        </p>
      ) : rows === null ? (
        <p className="muted mt-2 text-sm">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="muted mt-2 text-sm">No scans yet. Run a scan from the panel above.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1 text-sm">
          {rows.map((r) => (
            <li key={r.messageId} className="flex items-baseline justify-between gap-2">
              <span className="truncate" title={r.subject ?? ''}>
                {r.subject ?? '(no subject)'}
              </span>
              <span className="muted shrink-0 tabular-nums">
                {STATUS_LABEL[r.status] ?? r.status}
                {r.scannedAt ? ` · ${new Date(r.scannedAt).toLocaleDateString()}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </details>
  )
}
