import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@connor-adams/designsystem'
import { Button } from '@connor-adams/designsystem'
import { Card } from '@connor-adams/designsystem'
import { EmptyState } from '@connor-adams/designsystem'
import { useToast } from '@/components/ui/toast'
import { getJson, postJson } from '../../../lib/api'

/** GET /api/feedback row shape. */
type FeedbackRow = {
  id: number
  category: string
  body: string
  currentPath: string | null
  appVersion: string | null
  userAgent: string | null
  createdAt: string
  resolvedAt: string | null
}

const CATEGORY_LABELS: Record<string, string> = {
  bug: 'Bug',
  feature: 'Feature request',
  confusing: 'This is confusing',
  other: 'Other',
}

/**
 * Compact "3 days ago" style relative time. No date lib is bundled, so this is
 * a small, dependency-free formatter (mirrors MembersTab's timeAgo).
 */
function timeAgo(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const diffSec = Math.round((Date.now() - then) / 1000)
  if (diffSec < 60) return 'just now'
  const mins = Math.round(diffSec / 60)
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

/**
 * Owner-only feedback inbox (issue #295). Lists in-app feedback submissions
 * newest-first (the server orders by created_at DESC) with a "Mark resolved"
 * action per unresolved item. Single-user-style admin: the route is owner-only
 * and the tab is only mounted for the household owner.
 */
export function FeedbackInboxTab() {
  const { showToast } = useToast()
  const [rows, setRows] = useState<FeedbackRow[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setErr(null)
    try {
      const res = await getJson<{ data: FeedbackRow[]; count: number }>('/api/feedback')
      setRows(res.data)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load feedback')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function resolve(row: FeedbackRow) {
    try {
      await postJson(`/api/feedback/${row.id}/resolve`)
      await load()
    } catch (e) {
      showToast({
        title: e instanceof Error ? e.message : "Couldn't resolve. Try again.",
        variant: 'destructive',
      })
    }
  }

  return (
    <>
      <Card className="accountsFormCard">
        <div className="accountsCardHeader">
          <div>
            <h2>Feedback inbox</h2>
            <p className="muted">In-app feedback and bug reports, newest first.</p>
          </div>
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
        <EmptyState className="text-center" title="No feedback yet." />
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((row) => (
            <Card key={row.id} className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">
                    {CATEGORY_LABELS[row.category] ?? row.category}
                  </Badge>
                  {row.resolvedAt ? (
                    <Badge variant="outline">Resolved</Badge>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <span className="muted text-xs">{timeAgo(row.createdAt)}</span>
                  {!row.resolvedAt && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void resolve(row)}
                      aria-label={`Mark resolved: feedback ${row.id}`}
                    >
                      Mark resolved
                    </Button>
                  )}
                </div>
              </div>
              <p data-testid="feedback-body" className="whitespace-pre-wrap">
                {row.body}
              </p>
              {row.currentPath && (
                <p className="muted truncate text-xs">On: {row.currentPath}</p>
              )}
            </Card>
          ))}
        </div>
      )}
    </>
  )
}
