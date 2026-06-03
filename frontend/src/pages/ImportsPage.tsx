import { useEffect, useState } from 'react'
import { getJson, postJson } from '../lib/api'
import { useActiveImports, type BatchSummary } from '../components/import/useActiveImports'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/ui/page-header'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

type BatchDetail = {
  id: string
  status: string
  total: number
  processed: number
  succeeded: number
  failed: number
  skipped: number
  estimatedRemainingMs: number | null
  items: {
    fileName: string
    status: string
    accountName: string | null
    insertedTransactions: number
    insertedInvestmentActivities: number
    insertedHoldings: number
    skippedDuplicates: number
    reason: string | null
    error: string | null
  }[]
}

function statusLabel(status: string): string {
  switch (status) {
    case 'pending': return 'Pending'
    case 'processing': return 'Processing…'
    case 'done': return 'Done'
    case 'failed': return 'Failed'
    default: return status
  }
}

export function ImportsPage() {
  const { activeBatches } = useActiveImports()
  const [batches, setBatches] = useState<BatchSummary[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const [detail, setDetail] = useState<BatchDetail | null>(null)
  const [retrying, setRetrying] = useState<string | null>(null)

  // Re-fetch when active batch count changes (import in progress)
  useEffect(() => {
    void getJson<BatchSummary[]>('/api/import/pdf-batches').then(setBatches).catch(() => {})
  }, [activeBatches.length])

  useEffect(() => {
    if (open) {
      void getJson<BatchDetail>(`/api/import/pdf-batch/${open}`).then(setDetail).catch(() => {})
    } else {
      setDetail(null)
    }
  }, [open])

  const retry = async (id: string) => {
    setRetrying(id)
    try {
      await postJson(`/api/import/pdf-batch/${id}/retry`, {})
      const updated = await getJson<BatchDetail>(`/api/import/pdf-batch/${id}`)
      setDetail(updated)
      // Refresh the list too
      const all = await getJson<BatchSummary[]>('/api/import/pdf-batches')
      setBatches(all)
    } catch {
      // ignore — the row will refresh on next poll
    } finally {
      setRetrying(null)
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="Imports"
        description="PDF batch import history. Click a row to see per-file results."
      />

      <section className="card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Files</TableHead>
              <TableHead>Imported</TableHead>
              <TableHead>Skipped</TableHead>
              <TableHead>Failed</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {batches.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-center muted">
                  No import batches yet.
                </TableCell>
              </TableRow>
            )}
            {batches.map((b) => (
              <>
                <TableRow
                  key={b.id}
                  className="cursor-pointer"
                  onClick={() => setOpen(open === b.id ? null : b.id)}
                >
                  <TableCell className="whitespace-nowrap">
                    {new Date(b.createdAt).toLocaleString()}
                  </TableCell>
                  <TableCell>{statusLabel(b.status)}</TableCell>
                  <TableCell>{b.processed}/{b.total}</TableCell>
                  <TableCell>{b.succeeded}</TableCell>
                  <TableCell>{b.skipped}</TableCell>
                  <TableCell>
                    {b.failed > 0 ? (
                      <span className="text-red-600 dark:text-red-400">{b.failed}</span>
                    ) : (
                      b.failed
                    )}
                  </TableCell>
                  <TableCell>
                    {b.failed > 0 && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={retrying === b.id}
                        onClick={(e) => {
                          e.stopPropagation()
                          void retry(b.id)
                        }}
                      >
                        {retrying === b.id ? 'Retrying…' : 'Retry failed'}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
                {open === b.id && detail && (
                  <TableRow key={`${b.id}-detail`}>
                    <TableCell colSpan={7} className="bg-muted/30 p-0">
                      <div className="px-4 py-3 text-xs">
                        {detail.estimatedRemainingMs != null && (
                          <p className="muted mb-2">
                            ~{Math.max(1, Math.round(detail.estimatedRemainingMs / 60000))}m remaining
                          </p>
                        )}
                        <ul className="max-h-80 overflow-y-auto space-y-0.5">
                          {detail.items.map((it, i) => (
                            <li
                              key={i}
                              className="flex gap-2 py-0.5"
                              title={it.reason ?? it.error ?? ''}
                            >
                              <span
                                className={
                                  it.status === 'failed'
                                    ? 'text-red-600 dark:text-red-400 w-20 shrink-0'
                                    : it.status === 'skipped'
                                    ? 'text-amber-600 dark:text-amber-400 w-20 shrink-0'
                                    : 'w-20 shrink-0'
                                }
                              >
                                {it.status}
                              </span>
                              <span className="truncate flex-1">
                                {it.fileName}
                                {it.accountName ? ` → ${it.accountName}` : ''}
                                {it.status === 'done'
                                  ? ` (txn=${it.insertedTransactions} act=${it.insertedInvestmentActivities} hld=${it.insertedHoldings} skip=${it.skippedDuplicates})`
                                  : ''}
                                {it.reason ? ` · ${it.reason}` : ''}
                                {it.error ? ` · ERR: ${it.error}` : ''}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </>
            ))}
          </TableBody>
        </Table>
      </section>
    </div>
  )
}
