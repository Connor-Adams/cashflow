import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { getJson, postJson } from '../../../lib/api'
import { useToast } from '@/components/ui/toast'

type ExportStatus = 'queued' | 'running' | 'ready' | 'failed'

type ExportRow = {
  id: number
  status: ExportStatus
  requestedAt: string
  readyAt: string | null
  expiresAt: string | null
  byteSize: number | null
  errorMessage: string | null
  downloadParams: { exp: string; sig: string } | null
}

function daysUntil(dateStr: string | null): number | null {
  if (!dateStr) return null
  const ms = new Date(dateStr).getTime() - Date.now()
  return Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)))
}

function formatBytes(n: number | null): string {
  if (n == null) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function StatusPill({ status }: { status: ExportStatus }) {
  const map: Record<ExportStatus, { label: string; cls: string }> = {
    queued: { label: 'Queued', cls: 'bg-blue-100 text-blue-800' },
    running: { label: 'Preparing…', cls: 'bg-amber-100 text-amber-800' },
    ready: { label: 'Ready', cls: 'bg-green-100 text-green-800' },
    failed: { label: 'Failed', cls: 'bg-red-100 text-red-800' },
  }
  const { label, cls } = map[status] ?? { label: status, cls: 'bg-muted text-muted-foreground' }
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${cls}`}>
      {label}
    </span>
  )
}

export function DataTab() {
  const { showToast } = useToast()
  const [exports, setExports] = useState<ExportRow[]>([])
  const [loading, setLoading] = useState(true)
  const [requesting, setRequesting] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await getJson<{ exports: ExportRow[] }>('/api/me/exports')
      setExports(res.exports)
    } catch {
      // silently hide
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  // Poll while any export is in-flight.
  useEffect(() => {
    const inFlight = exports.some((e) => e.status === 'queued' || e.status === 'running')
    if (!inFlight) return
    const t = setInterval(() => { void load() }, 5000)
    return () => clearInterval(t)
  }, [exports, load])

  const requestExport = async () => {
    setRequesting(true)
    try {
      await postJson('/api/me/export', {})
      showToast({ title: 'Backup requested. We will prepare your archive.', variant: 'success' })
      void load()
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Request failed'
      showToast({ title: msg, variant: 'error' })
    } finally {
      setRequesting(false)
    }
  }

  const downloadUrl = (row: ExportRow): string => {
    if (!row.downloadParams) return '#'
    const { exp, sig } = row.downloadParams
    return `/api/me/export/${row.id}/download?exp=${exp}&sig=${sig}`
  }

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold">Your data</h2>
            <p className="muted text-sm">
              Cashflow stores everything you do here. Download a portable copy anytime.
            </p>
          </div>
          <Button onClick={() => void requestExport()} disabled={requesting}>
            {requesting ? 'Requesting…' : 'Request a backup'}
          </Button>
        </div>
      </Card>

      {loading && <p className="muted text-sm">Loading…</p>}

      {!loading && exports.length === 0 && (
        <Card className="p-4">
          <p className="muted text-sm">
            You have not exported your data yet. Press the button to request a backup.
          </p>
        </Card>
      )}

      {exports.length > 0 && (
        <Card>
          <div className="divide-y">
            {exports.map((row) => {
              const days = daysUntil(row.expiresAt)
              return (
                <div key={row.id} className="flex items-center gap-3 px-4 py-3 text-sm">
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-muted-foreground">
                      Requested {new Date(row.requestedAt).toLocaleString()}
                    </div>
                    {row.status === 'ready' && days != null && (
                      <div className="text-xs text-muted-foreground">
                        Expires in {days} day{days !== 1 ? 's' : ''}
                        {row.byteSize ? ` · ${formatBytes(row.byteSize)}` : ''}
                      </div>
                    )}
                    {row.status === 'failed' && row.errorMessage && (
                      <div className="text-xs text-destructive">{row.errorMessage}</div>
                    )}
                  </div>
                  <StatusPill status={row.status} />
                  {row.status === 'ready' && row.downloadParams && (
                    <a
                      href={downloadUrl(row)}
                      download
                      className="inline-flex items-center rounded px-3 py-1 text-xs font-medium border hover:bg-muted/50 transition-colors"
                    >
                      Download
                    </a>
                  )}
                </div>
              )
            })}
          </div>
        </Card>
      )}
    </div>
  )
}
