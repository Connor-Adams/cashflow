/**
 * Insights inbox — surfaces deterministic detector findings from the
 * `insights` table (issue #204). Each row carries a severity badge, a
 * short title, supporting detail, and dismiss / resolve actions.
 *
 * Severity ordering matches the backend `SEVERITY_RANK` (critical > warning
 * > info). Within a severity we sort by detectedAt desc.
 *
 * Future #210 layers an AI review pass on top of this same table — the row
 * shape is shared with that future endpoint.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@connor-adams/designsystem'
import { Badge } from '@connor-adams/designsystem'
import { Alert } from '@connor-adams/designsystem'
import { EmptyState } from '@connor-adams/designsystem'
import { getJson, patchJson, postJson } from '@/lib/api'

export type InsightSeverity = 'info' | 'warning' | 'critical'
export type InsightStatus = 'open' | 'dismissed' | 'resolved'

export type InsightRow = {
  id: number
  type: string
  severity: InsightSeverity
  title: string
  description: string | null
  entityType: string | null
  entityId: number | null
  status: InsightStatus
  metadata: unknown
  detectedAt: string
  createdAt: string
  updatedAt: string
}

type InsightsListResponse = { data: InsightRow[] }
type RunResponse = { created: number; refreshed: number; total: number }

type Tab = 'open' | 'dismissed' | 'resolved'

const TAB_ORDER: Tab[] = ['open', 'dismissed', 'resolved']

const TAB_LABEL: Record<Tab, string> = {
  open: 'Open',
  dismissed: 'Dismissed',
  resolved: 'Resolved',
}

const SEVERITY_RANK: Record<InsightSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
}

const SEVERITY_VARIANT: Record<InsightSeverity, 'destructive' | 'secondary' | 'outline'> = {
  critical: 'destructive',
  warning: 'secondary',
  info: 'outline',
}

function compareInsights(a: InsightRow, b: InsightRow): number {
  const diff = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
  if (diff !== 0) return diff
  if (a.detectedAt !== b.detectedAt) return a.detectedAt < b.detectedAt ? 1 : -1
  return b.id - a.id
}

function entityHref(row: InsightRow): string | null {
  // The forecast drill-down is a derivation, not a row — it has no entityId.
  if (row.entityType === 'forecast') return '/planned/forecast'
  if (!row.entityType || row.entityId == null) return null
  switch (row.entityType) {
    case 'transaction':
      return `/transactions?ids=${row.entityId}`
    case 'contact':
      return `/settings/contacts?contactId=${row.entityId}`
    default:
      return null
  }
}

export function InsightsPage() {
  const [rows, setRows] = useState<InsightRow[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [tab, setTab] = useState<Tab>('open')
  const [errorById, setErrorById] = useState<Record<number, string | null>>({})

  const fetchInsights = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const r = await getJson<InsightsListResponse>('/api/insights')
      setRows(r.data)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load insights')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchInsights()
  }, [fetchInsights])

  const sortedRows = useMemo(() => [...rows].sort(compareInsights), [rows])

  const counts = useMemo(() => {
    const c: Record<Tab, number> = { open: 0, dismissed: 0, resolved: 0 }
    for (const row of rows) c[row.status] += 1
    return c
  }, [rows])

  const visible = sortedRows.filter((r) => r.status === tab)

  async function runDetectors() {
    setRunning(true)
    setErr(null)
    try {
      await postJson<RunResponse>('/api/insights/run')
      await fetchInsights()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to run detectors')
    } finally {
      setRunning(false)
    }
  }

  async function updateStatus(row: InsightRow, status: InsightStatus) {
    const original = rows
    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, status } : r)))
    try {
      const updated = await patchJson<InsightRow>(`/api/insights/${row.id}`, { status })
      setRows((prev) => prev.map((r) => (r.id === row.id ? updated : r)))
    } catch (e) {
      setRows(original)
      setErrorById((prev) => ({
        ...prev,
        [row.id]: e instanceof Error ? e.message : 'Failed',
      }))
    }
  }

  return (
    <main className="p-6 max-w-5xl mx-auto">
      <header className="flex items-baseline justify-between mb-4">
        <div>
          <h1 className="text-2xl font-semibold">Insights</h1>
          <p className="text-sm text-muted-foreground">
            {rows.length} total · {counts.open} open
          </p>
        </div>
        <Button type="button" onClick={() => void runDetectors()} disabled={running}>
          {running ? 'Running…' : 'Run detectors'}
        </Button>
      </header>

      <nav
        className="flex gap-2 border-b border-border mb-4"
        aria-label="Filter by status"
      >
        {TAB_ORDER.map((t) => (
          <Button
            key={t}
            type="button"
            variant="ghost"
            onClick={() => setTab(t)}
            aria-pressed={tab === t}
            className={
              tab === t
                ? 'px-3 py-2 border-b-2 border-primary font-semibold rounded-none'
                : 'px-3 py-2 border-b-2 border-transparent text-muted-foreground rounded-none'
            }
          >
            {TAB_LABEL[t]} <span className="text-xs">({counts[t]})</span>
          </Button>
        ))}
      </nav>

      {err ? <Alert variant="error" className="mb-2">{err}</Alert> : null}
      {loading ? <p className="text-sm leading-6 text-muted-foreground">Loading…</p> : null}
      {!loading && visible.length === 0 ? (
        rows.length === 0 ? (
          <EmptyState
            title="No insights yet"
            description="Run the detectors to scan your recent activity for anything worth a look."
            actions={
              <Button
                type="button"
                size="sm"
                onClick={() => void runDetectors()}
                disabled={running}
              >
                {running ? 'Running…' : 'Run detectors'}
              </Button>
            }
          />
        ) : (
          <EmptyState
            title="Nothing matches this filter"
            description={`No ${TAB_LABEL[tab].toLowerCase()} insights right now. Clear the filter to see everything.`}
            actions={
              <Button type="button" size="sm" variant="outline" onClick={() => setTab('open')}>
                Clear filters
              </Button>
            }
          />
        )
      ) : null}

      <ul className="flex flex-col gap-3">
        {visible.map((row) => {
          const itemErr = errorById[row.id]
          const link = entityHref(row)
          return (
            <li
              key={row.id}
              className="rounded-lg border border-border bg-[var(--bg2)] p-4"
              data-testid="insight-row"
              data-insight-id={row.id}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <Badge variant={SEVERITY_VARIANT[row.severity]}>{row.severity}</Badge>
                    <span className="text-xs text-muted-foreground">{row.type.replace(/_/g, ' ')}</span>
                  </div>
                  <p className="font-semibold mb-1">{row.title}</p>
                  {row.description ? (
                    <p className="text-sm text-muted-foreground">{row.description}</p>
                  ) : null}
                </div>
                <div className="flex flex-col gap-2 items-end shrink-0">
                  {link ? (
                    <Link
                      to={link}
                      className="text-sm underline-offset-4 hover:underline text-primary"
                    >
                      View
                    </Link>
                  ) : null}
                  {row.status === 'open' ? (
                    <>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() => void updateStatus(row, 'dismissed')}
                      >
                        Dismiss
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => void updateStatus(row, 'resolved')}
                      >
                        Resolve
                      </Button>
                    </>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => void updateStatus(row, 'open')}
                    >
                      Reopen
                    </Button>
                  )}
                </div>
              </div>
              {itemErr ? <Alert variant="error" className="mt-2">{itemErr}</Alert> : null}
            </li>
          )
        })}
      </ul>
    </main>
  )
}
