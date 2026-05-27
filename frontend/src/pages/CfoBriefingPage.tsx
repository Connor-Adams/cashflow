import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { SeverityBadge, type InsightSeverity } from '@/components/ai/SeverityBadge'
import { getJson, postJson } from '@/lib/api'
import { formatMoney } from '@/lib/formatMoney'

/**
 * Personal CFO briefing page (issue #236).
 *
 * Generates and displays daily/weekly finance briefings — a deterministic
 * roll-up across forecast, safe-to-spend, subscriptions, receipts, imports,
 * rules and review backlog. Differs from the AI Review page (#210, monthly)
 * by scope and by surfacing the safe-to-spend headline as the hero.
 */

type CfoActionItemStatus = 'open' | 'resolved' | 'dismissed'

type CfoActionItemType =
  | 'forecast_warning'
  | 'safe_to_spend_low'
  | 'missing_receipt'
  | 'new_subscription'
  | 'rule_suggestion'
  | 'review_backlog'
  | 'import_issue'
  | 'anomaly'
  | 'other'

type CfoActionItem = {
  id: string
  type: CfoActionItemType
  refType: 'transaction' | 'event' | 'rule' | 'subscription' | 'import' | null
  refId: number | null
  severity: InsightSeverity
  title: string
  summary: string
  status: CfoActionItemStatus
  supportingTransactionIds?: number[]
  rationale?: string
  link?: string
}

type CfoSafeToSpendSnapshot = {
  value: number
  currency: string
  isNegative: boolean
  windowDays: number
  windowEndDate: string
  asOfDate: string
}

type CfoBriefing = {
  id: number
  periodStart: string
  periodEnd: string
  currency: string
  status: 'pending' | 'completed' | 'failed'
  summary: string | null
  actionItems: CfoActionItem[]
  safeToSpendSnapshot: CfoSafeToSpendSnapshot | null
  errorMessage: string | null
  createdAt: string
}

type ListResponse = { data: CfoBriefing[] }

const TYPE_LABEL: Record<CfoActionItemType, string> = {
  forecast_warning: 'Forecast warning',
  safe_to_spend_low: 'Safe-to-spend alert',
  missing_receipt: 'Missing receipt',
  new_subscription: 'New subscription',
  rule_suggestion: 'Rule suggestion',
  review_backlog: 'Review backlog',
  import_issue: 'Import issue',
  anomaly: 'Anomaly',
  other: 'Other',
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function daysAgoIso(days: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().slice(0, 10)
}

export function CfoBriefingPage() {
  const [briefings, setBriefings] = useState<CfoBriefing[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [periodStart, setPeriodStart] = useState<string>(daysAgoIso(6))
  const [periodEnd, setPeriodEnd] = useState<string>(todayIso())
  const [selectedId, setSelectedId] = useState<number | null>(null)

  const fetchBriefings = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const r = await getJson<ListResponse>('/api/cfo/briefings')
      setBriefings(r.data)
      if (r.data.length > 0 && selectedId == null) {
        setSelectedId(r.data[0].id)
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load briefings')
    } finally {
      setLoading(false)
    }
  }, [selectedId])

  useEffect(() => {
    void fetchBriefings()
  }, [fetchBriefings])

  const selected = useMemo(
    () => briefings.find((b) => b.id === selectedId) ?? null,
    [briefings, selectedId],
  )

  async function createBriefing() {
    setCreating(true)
    setErr(null)
    try {
      const r = await postJson<CfoBriefing>('/api/cfo/briefings', {
        periodStart,
        periodEnd,
      })
      setBriefings((prev) => [r, ...prev])
      setSelectedId(r.id)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to generate briefing')
    } finally {
      setCreating(false)
    }
  }

  async function setItemStatus(
    item: CfoActionItem,
    action: 'resolve' | 'dismiss',
  ) {
    if (selected == null) return
    const original = selected
    const newStatus: CfoActionItemStatus =
      action === 'resolve' ? 'resolved' : 'dismissed'
    // Optimistic update — revert below on failure.
    setBriefings((prev) =>
      prev.map((b) =>
        b.id === selected.id
          ? {
              ...b,
              actionItems: b.actionItems.map((it) =>
                it.id === item.id ? { ...it, status: newStatus } : it,
              ),
            }
          : b,
      ),
    )
    try {
      const updated = await postJson<CfoBriefing>(
        `/api/cfo/briefings/${selected.id}/items/${encodeURIComponent(item.id)}/${action}`,
      )
      setBriefings((prev) => prev.map((b) => (b.id === updated.id ? updated : b)))
    } catch (e) {
      setBriefings((prev) => prev.map((b) => (b.id === original.id ? original : b)))
      setErr(e instanceof Error ? e.message : `Failed to ${action} item`)
    }
  }

  const counts = useMemo(() => {
    if (selected == null) return { open: 0, resolved: 0, dismissed: 0 }
    return selected.actionItems.reduce(
      (acc, item) => {
        acc[item.status] += 1
        return acc
      },
      { open: 0, resolved: 0, dismissed: 0 } as Record<CfoActionItemStatus, number>,
    )
  }, [selected])

  return (
    <main className="cfoBriefingPage">
      <header className="mb-4">
        <h1>Personal CFO briefing</h1>
        <p className="muted">
          A daily or weekly roll-up across your forecast, safe-to-spend,
          subscriptions, receipts, imports, rules and review queue. Items
          link to the cleanup workflow that resolves them.
        </p>
      </header>

      <section
        className="card mb-4 p-4"
        aria-label="Generate a new briefing"
      >
        <h2 className="text-base font-semibold mb-2">New briefing</h2>
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
            onClick={() => void createBriefing()}
            disabled={creating || !periodStart || !periodEnd}
          >
            {creating ? 'Generating…' : 'Generate briefing'}
          </Button>
        </div>
        <p className="muted mt-2 text-xs">
          Briefings cover up to 14 days; defaults to the last 7 days through today.
        </p>
      </section>

      {err ? <p className="error mb-3">{err}</p> : null}
      {loading ? <p className="muted">Loading…</p> : null}

      <div className="cfoBriefingLayout grid gap-4 md:grid-cols-[280px_1fr]">
        <aside aria-label="Previous briefings">
          <h2 className="text-base font-semibold mb-2">Previous briefings</h2>
          {briefings.length === 0 && !loading ? (
            <p className="emptyState muted">
              No briefings yet. Generate one above. <Link to="/">Dashboard</Link>
            </p>
          ) : (
            <ul className="cfoBriefingList space-y-1">
              {briefings.map((b) => {
                const isSelected = b.id === selectedId
                return (
                  <li key={b.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(b.id)}
                      className={`w-full text-left rounded px-2 py-2 border ${
                        isSelected ? 'bg-accent' : 'bg-card'
                      }`}
                      aria-pressed={isSelected}
                    >
                      <div className="text-sm font-medium">
                        {b.periodStart} → {b.periodEnd}
                      </div>
                      <div className="text-xs muted">
                        {b.status === 'failed'
                          ? `Failed${b.errorMessage ? `: ${b.errorMessage}` : ''}`
                          : b.summary ?? `${b.actionItems.length} items`}
                      </div>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </aside>

        <section aria-label="Selected briefing detail">
          {selected ? (
            <>
              <header className="mb-2 flex flex-wrap items-baseline gap-2">
                <h2 className="text-lg font-semibold">
                  {selected.periodStart} → {selected.periodEnd}
                </h2>
                <span className="text-xs muted">
                  {counts.open} open · {counts.resolved} resolved ·{' '}
                  {counts.dismissed} dismissed
                </span>
              </header>

              {selected.safeToSpendSnapshot ? (
                <div
                  className={`rounded border p-3 mb-3 ${
                    selected.safeToSpendSnapshot.isNegative
                      ? 'border-destructive bg-destructive/5'
                      : 'bg-card'
                  }`}
                >
                  <p className="text-xs muted">
                    Safe to spend · {selected.safeToSpendSnapshot.windowDays}-day
                    window through {selected.safeToSpendSnapshot.windowEndDate}
                  </p>
                  <p
                    className={`text-2xl font-semibold tabular-nums ${
                      selected.safeToSpendSnapshot.isNegative
                        ? 'text-destructive'
                        : ''
                    }`}
                  >
                    {formatMoney(
                      selected.safeToSpendSnapshot.value,
                      selected.safeToSpendSnapshot.currency,
                    )}
                  </p>
                </div>
              ) : null}

              {selected.summary ? (
                <p className="muted mb-3">{selected.summary}</p>
              ) : null}
              {selected.status === 'failed' && selected.errorMessage ? (
                <p className="error mb-3">{selected.errorMessage}</p>
              ) : null}

              <ul className="cfoBriefingItems space-y-2">
                {selected.actionItems.map((item) => (
                  <li
                    key={item.id}
                    className={`rounded border p-3 ${
                      item.status === 'dismissed'
                        ? 'opacity-50'
                        : item.status === 'resolved'
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
                          {item.status !== 'open' ? (
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
                        {item.link ? (
                          <div className="text-xs mt-1">
                            <Link to={item.link} className="underline">
                              Open cleanup workflow
                            </Link>
                          </div>
                        ) : null}
                      </div>
                      <div className="flex gap-1 shrink-0">
                        {item.status === 'open' ? (
                          <>
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => void setItemStatus(item, 'resolve')}
                            >
                              Resolve
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
              Select a briefing on the left or generate a new one above.
            </p>
          )}
        </section>
      </div>
    </main>
  )
}
