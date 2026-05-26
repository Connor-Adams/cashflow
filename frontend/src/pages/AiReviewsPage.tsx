import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { SeverityBadge, type InsightSeverity } from '@/components/ai/SeverityBadge'
import { getJson, postJson } from '@/lib/api'

type AiReviewActionItemStatus = 'suggested' | 'accepted' | 'dismissed'

type AiReviewActionItemType =
  | 'anomaly'
  | 'rule_suggestion'
  | 'missing_receipt'
  | 'subscription'
  | 'forecast_warning'
  | 'other'

type AiReviewActionItem = {
  id: string
  type: AiReviewActionItemType
  refType: 'transaction' | 'event' | 'rule' | null
  refId: number | null
  severity: InsightSeverity
  title: string
  summary: string
  status: AiReviewActionItemStatus
  supportingTransactionIds?: number[]
  rationale?: string
}

type AiReviewRun = {
  id: number
  periodStart: string
  periodEnd: string
  currency: string
  status: 'pending' | 'completed' | 'failed'
  summary: string | null
  actionItems: AiReviewActionItem[]
  errorMessage: string | null
  createdAt: string
}

type ListResponse = { data: AiReviewRun[] }

const TYPE_LABEL: Record<AiReviewActionItemType, string> = {
  anomaly: 'Anomaly',
  rule_suggestion: 'Rule suggestion',
  missing_receipt: 'Missing receipt',
  subscription: 'Subscription',
  forecast_warning: 'Forecast warning',
  other: 'Other',
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function startOfMonthIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

export function AiReviewsPage() {
  const [runs, setRuns] = useState<AiReviewRun[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [periodStart, setPeriodStart] = useState<string>(startOfMonthIso())
  const [periodEnd, setPeriodEnd] = useState<string>(todayIso())
  const [selectedId, setSelectedId] = useState<number | null>(null)

  const fetchRuns = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const r = await getJson<ListResponse>('/api/ai/reviews')
      setRuns(r.data)
      if (r.data.length > 0 && selectedId == null) {
        setSelectedId(r.data[0].id)
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load reviews')
    } finally {
      setLoading(false)
    }
  }, [selectedId])

  useEffect(() => {
    void fetchRuns()
  }, [fetchRuns])

  const selected = useMemo(
    () => runs.find((r) => r.id === selectedId) ?? null,
    [runs, selectedId],
  )

  async function createReview() {
    setCreating(true)
    setErr(null)
    try {
      const r = await postJson<AiReviewRun>('/api/ai/review', {
        periodStart,
        periodEnd,
      })
      setRuns((prev) => [r, ...prev])
      setSelectedId(r.id)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to create review')
    } finally {
      setCreating(false)
    }
  }

  async function setItemStatus(item: AiReviewActionItem, action: 'accept' | 'dismiss') {
    if (selected == null) return
    const original = selected
    const newStatus: AiReviewActionItemStatus =
      action === 'accept' ? 'accepted' : 'dismissed'
    // Optimistic update.
    setRuns((prev) =>
      prev.map((run) =>
        run.id === selected.id
          ? {
              ...run,
              actionItems: run.actionItems.map((it) =>
                it.id === item.id ? { ...it, status: newStatus } : it,
              ),
            }
          : run,
      ),
    )
    try {
      const updated = await postJson<AiReviewRun>(
        `/api/ai/reviews/${selected.id}/items/${encodeURIComponent(item.id)}/${action}`,
      )
      setRuns((prev) => prev.map((run) => (run.id === updated.id ? updated : run)))
    } catch (e) {
      setRuns((prev) => prev.map((run) => (run.id === original.id ? original : run)))
      setErr(e instanceof Error ? e.message : `Failed to ${action} item`)
    }
  }

  const counts = useMemo(() => {
    if (selected == null) return { suggested: 0, accepted: 0, dismissed: 0 }
    return selected.actionItems.reduce(
      (acc, item) => {
        acc[item.status] += 1
        return acc
      },
      { suggested: 0, accepted: 0, dismissed: 0 } as Record<
        AiReviewActionItemStatus,
        number
      >,
    )
  }, [selected])

  return (
    <main className="aiReviewsPage">
      <header className="mb-4">
        <h1>AI Finance Review</h1>
        <p className="muted">
          Generate a periodic review of spending, subscriptions, missing
          receipts, rule suggestions, and forecast warnings.
        </p>
      </header>

      <section
        className="card mb-4 p-4"
        aria-label="Create a new review run"
      >
        <h2 className="text-base font-semibold mb-2">New review</h2>
        <div className="flex flex-wrap gap-2 items-end">
          <label className="text-sm flex flex-col">
            <span className="muted">Period start</span>
            <input
              type="date"
              value={periodStart}
              onChange={(e) => setPeriodStart(e.target.value)}
              className="border rounded px-2 py-1"
            />
          </label>
          <label className="text-sm flex flex-col">
            <span className="muted">Period end</span>
            <input
              type="date"
              value={periodEnd}
              onChange={(e) => setPeriodEnd(e.target.value)}
              className="border rounded px-2 py-1"
            />
          </label>
          <Button
            type="button"
            onClick={() => void createReview()}
            disabled={creating || !periodStart || !periodEnd}
          >
            {creating ? 'Generating…' : 'Generate review'}
          </Button>
        </div>
      </section>

      {err ? <p className="error mb-3">{err}</p> : null}
      {loading ? <p className="muted">Loading…</p> : null}

      <div className="aiReviewsLayout grid gap-4 md:grid-cols-[280px_1fr]">
        <aside aria-label="Previous reviews">
          <h2 className="text-base font-semibold mb-2">Previous reviews</h2>
          {runs.length === 0 && !loading ? (
            <p className="emptyState muted">
              No reviews yet. Generate one above. <Link to="/">Dashboard</Link>
            </p>
          ) : (
            <ul className="aiReviewsList space-y-1">
              {runs.map((run) => {
                const isSelected = run.id === selectedId
                return (
                  <li key={run.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(run.id)}
                      className={`w-full text-left rounded px-2 py-2 border ${
                        isSelected ? 'bg-accent' : 'bg-card'
                      }`}
                      aria-pressed={isSelected}
                    >
                      <div className="text-sm font-medium">
                        {run.periodStart} → {run.periodEnd}
                      </div>
                      <div className="text-xs muted">
                        {run.status === 'failed'
                          ? `Failed${run.errorMessage ? `: ${run.errorMessage}` : ''}`
                          : run.summary ?? `${run.actionItems.length} items`}
                      </div>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </aside>

        <section aria-label="Selected review details">
          {selected ? (
            <>
              <header className="mb-2 flex flex-wrap items-baseline gap-2">
                <h2 className="text-lg font-semibold">
                  {selected.periodStart} → {selected.periodEnd}
                </h2>
                <span className="text-xs muted">
                  {counts.suggested} pending · {counts.accepted} accepted · {counts.dismissed} dismissed
                </span>
              </header>
              {selected.summary ? (
                <p className="muted mb-3">{selected.summary}</p>
              ) : null}
              {selected.status === 'failed' && selected.errorMessage ? (
                <p className="error mb-3">{selected.errorMessage}</p>
              ) : null}
              <ul className="aiReviewItems space-y-2">
                {selected.actionItems.map((item) => (
                  <li
                    key={item.id}
                    className={`rounded border p-3 ${
                      item.status === 'dismissed'
                        ? 'opacity-50'
                        : item.status === 'accepted'
                          ? 'border-green-500'
                          : ''
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <SeverityBadge severity={item.severity} />
                          <span className="text-xs muted">
                            {TYPE_LABEL[item.type]}
                          </span>
                          {item.status !== 'suggested' ? (
                            <span className="text-xs uppercase tracking-wide">
                              {item.status}
                            </span>
                          ) : null}
                        </div>
                        <div className="font-medium">{item.title}</div>
                        <div className="text-sm muted">{item.summary}</div>
                        {item.rationale ? (
                          <div className="text-xs muted mt-1">
                            <em>{item.rationale}</em>
                          </div>
                        ) : null}
                      </div>
                      <div className="flex gap-1 shrink-0">
                        {item.status === 'suggested' ? (
                          <>
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => void setItemStatus(item, 'accept')}
                            >
                              Accept
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => void setItemStatus(item, 'dismiss')}
                            >
                              Dismiss
                            </Button>
                          </>
                        ) : null}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="emptyState muted">
              Select a review on the left or generate a new one above.
            </p>
          )}
        </section>
      </div>
    </main>
  )
}
