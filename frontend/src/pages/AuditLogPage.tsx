/**
 * AuditLogPage — read-only viewer for the household's finance audit log
 * (Cashflow #228).
 *
 * Reads from GET /api/audit-log with filters. Each row renders the
 * action, actor, summary, and a collapsible JSON view of before/after/
 * metadata for forensic inspection. The page is intentionally
 * minimal-chrome — power-user diagnostic surface, not a polished
 * dashboard.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Card, CardContent } from '@cashflow/ui'
import { Button } from '@cashflow/ui'
import { PageHeader } from '@/components/ui/page-header'
import { NativeSelect } from '@cashflow/ui'
import { Alert } from '@cashflow/ui'
import { getJson } from '../lib/api'
import type { AuditLogEntry, AuditLogResponse } from '../types/api'

const PAGE_SIZE = 25

/**
 * Curated list of action filters. Free-form on the backend, but the UI
 * surfaces a fixed dropdown so users can find the most common ones.
 * Adding a new action here is cheap; unknown actions still render via
 * the row template — they just don't appear in the filter dropdown.
 */
const ACTION_FILTER_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'All actions' },
  { value: 'transaction.updated', label: 'Transaction updated' },
  { value: 'transaction.bulk_updated', label: 'Transaction bulk updated' },
  {
    value: 'transaction.bulk_filter_updated',
    label: 'Transaction bulk-filter updated',
  },
  { value: 'rule.created', label: 'Rule created' },
  { value: 'rule.updated', label: 'Rule updated' },
  { value: 'rule.deleted', label: 'Rule deleted' },
  { value: 'ai_suggestion.accepted', label: 'AI suggestion accepted' },
  { value: 'ai_suggestion.dismissed', label: 'AI suggestion dismissed' },
  { value: 'settlement.created', label: 'Settlement created' },
  { value: 'settlement.deleted', label: 'Settlement deleted' },
  { value: 'receipt.created', label: 'Receipt created' },
  { value: 'receipt.deleted', label: 'Receipt deleted' },
  { value: 'import.committed', label: 'Import committed' },
]

const ENTITY_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'All entity types' },
  { value: 'transaction', label: 'Transaction' },
  { value: 'rule', label: 'Rule' },
  { value: 'ai_suggestion', label: 'AI suggestion' },
  { value: 'settlement', label: 'Settlement' },
  { value: 'receipt', label: 'Receipt' },
  { value: 'import', label: 'Import' },
]

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

function actionLabel(action: string): string {
  const known = ACTION_FILTER_OPTIONS.find((o) => o.value === action)
  if (known) return known.label
  return action
}

export function AuditLogPage() {
  const [data, setData] = useState<AuditLogResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [action, setAction] = useState('')
  const [entityType, setEntityType] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [offset, setOffset] = useState(0)

  const queryString = useMemo(() => {
    const params = new URLSearchParams()
    if (action) params.set('action', action)
    if (entityType) params.set('entityType', entityType)
    if (dateFrom) params.set('dateFrom', dateFrom)
    if (dateTo) params.set('dateTo', dateTo)
    params.set('limit', String(PAGE_SIZE))
    params.set('offset', String(offset))
    return params.toString()
  }, [action, entityType, dateFrom, dateTo, offset])

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const res = await getJson<AuditLogResponse>(`/api/audit-log?${queryString}`)
      setData(res)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Error')
    } finally {
      setLoading(false)
    }
  }, [queryString])

  useEffect(() => {
    void load()
  }, [load])

  // Reset offset whenever filters change so users don't end up on an
  // out-of-range page when the result set shrinks.
  useEffect(() => {
    setOffset(0)
  }, [action, entityType, dateFrom, dateTo])

  const items = data?.items ?? []
  const total = data?.total ?? 0
  const hasNext = offset + PAGE_SIZE < total
  const hasPrev = offset > 0

  return (
    <div className="space-y-4">
      <PageHeader
        title="Audit log"
        description="Forensic timeline of finance-data changes for your household."
      />

      <Card>
        <CardContent className="pt-4">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <label className="text-sm">
              <span className="block mb-1 text-muted-foreground">Action</span>
              <NativeSelect
                value={action}
                onChange={(e) => setAction(e.target.value)}
              >
                {ACTION_FILTER_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <label className="text-sm">
              <span className="block mb-1 text-muted-foreground">Entity type</span>
              <NativeSelect
                value={entityType}
                onChange={(e) => setEntityType(e.target.value)}
              >
                {ENTITY_TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <label className="text-sm">
              <span className="block mb-1 text-muted-foreground">From</span>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </label>
            <label className="text-sm">
              <span className="block mb-1 text-muted-foreground">To</span>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </label>
          </div>
        </CardContent>
      </Card>

      {err && <Alert variant="error">{err}</Alert>}
      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}

      {!loading && items.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No audit entries match the current filters.
        </p>
      )}

      <ol className="space-y-2">
        {items.map((row) => (
          <AuditRow key={row.id} row={row} />
        ))}
      </ol>

      <div className="flex items-center justify-between pt-2">
        <p className="text-xs text-muted-foreground">
          {total === 0
            ? 'No results'
            : `${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} of ${total}`}
        </p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!hasPrev || loading}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!hasNext || loading}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * Single audit row. The before/after/metadata blob is collapsed by
 * default — open via click to expand.
 */
function AuditRow({ row }: { row: AuditLogEntry }) {
  const [open, setOpen] = useState(false)
  const hasDetails =
    row.before != null || row.after != null || row.metadata != null
  return (
    <li>
      <Card>
        <CardContent className="pt-3 pb-3">
          <div className="flex items-start gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-0.5"
              aria-label={open ? 'Collapse details' : 'Expand details'}
              onClick={() => setOpen((v) => !v)}
              disabled={!hasDetails}
            >
              {open ? (
                <ChevronDown size={16} />
              ) : (
                <ChevronRight size={16} />
              )}
            </Button>
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline flex-wrap gap-2">
                <span className="text-sm font-medium">{actionLabel(row.action)}</span>
                <span className="text-xs text-muted-foreground">
                  {row.entityType}
                  {row.entityId != null ? ` #${row.entityId}` : ''}
                </span>
                <span className="text-xs text-muted-foreground ml-auto">
                  {formatTimestamp(row.createdAt)}
                </span>
              </div>
              {row.summary && (
                <p className="text-sm mt-0.5 text-foreground/90">{row.summary}</p>
              )}
              <p className="text-xs text-muted-foreground mt-0.5">
                {row.actorDisplayName ??
                  row.actorEmail ??
                  (row.actorUserId != null
                    ? `User #${row.actorUserId}`
                    : 'System')}
              </p>
              {open && hasDetails && (
                <div className="mt-2 grid grid-cols-1 md:grid-cols-3 gap-2 text-xs">
                  {row.before != null && (
                    <DetailsBlock title="Before" payload={row.before} />
                  )}
                  {row.after != null && (
                    <DetailsBlock title="After" payload={row.after} />
                  )}
                  {row.metadata != null && (
                    <DetailsBlock title="Metadata" payload={row.metadata} />
                  )}
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </li>
  )
}

function DetailsBlock({ title, payload }: { title: string; payload: unknown }) {
  let text = ''
  try {
    text = JSON.stringify(payload, null, 2)
  } catch {
    text = String(payload)
  }
  return (
    <div>
      <p className="text-muted-foreground mb-1">{title}</p>
      <pre className="bg-muted/40 rounded p-2 overflow-x-auto whitespace-pre-wrap break-words text-[11px] leading-tight">
        {text}
      </pre>
    </div>
  )
}
