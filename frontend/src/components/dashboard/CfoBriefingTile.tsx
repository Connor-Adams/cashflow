import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { BentoTile } from './BentoTile'
import { Button } from '@/components/ui/button'
import { getJson, postJson } from '@/lib/api'
import { formatMoney } from '@/lib/formatMoney'

/**
 * Dashboard tile (issue #236). Shows the most recent CFO briefing —
 * safe-to-spend headline + top action items — with a button to generate
 * a fresh one. Empty state explains the feature and links to the
 * briefing page.
 */

type CfoActionItemStatus = 'open' | 'resolved' | 'dismissed'

type CfoActionItem = {
  id: string
  type: string
  severity: 'info' | 'watch' | 'action'
  title: string
  summary: string
  status: CfoActionItemStatus
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
  status: 'pending' | 'completed' | 'failed'
  summary: string | null
  actionItems: CfoActionItem[]
  safeToSpendSnapshot: CfoSafeToSpendSnapshot | null
  createdAt: string
}

type ListResponse = { data: CfoBriefing[] }

const MAX_VISIBLE_ITEMS = 3

export function CfoBriefingTile() {
  const [latest, setLatest] = useState<CfoBriefing | null>(null)
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const fetchLatest = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const r = await getJson<ListResponse>('/api/cfo/briefings?limit=1')
      setLatest(r.data[0] ?? null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load briefing')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchLatest()
  }, [fetchLatest])

  async function generate() {
    setCreating(true)
    setErr(null)
    try {
      const r = await postJson<CfoBriefing>('/api/cfo/briefings', {})
      setLatest(r)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to generate briefing')
    } finally {
      setCreating(false)
    }
  }

  const topItems = useMemo(() => {
    if (!latest) return [] as CfoActionItem[]
    return latest.actionItems
      .filter((it) => it.status === 'open')
      .sort((a, b) => severityRank(b.severity) - severityRank(a.severity))
      .slice(0, MAX_VISIBLE_ITEMS)
  }, [latest])

  const openCount = useMemo(
    () => latest?.actionItems.filter((i) => i.status === 'open').length ?? 0,
    [latest],
  )

  return (
    <BentoTile
      span={6}
      rows={2}
      aria-busy={loading}
      label="CFO briefing"
      description="Daily/weekly roll-up across forecast, safe-to-spend, subscriptions, receipts, imports, rules, and review."
    >
      {loading && !latest ? (
        <p className="text-sm text-muted-foreground">Loading briefing…</p>
      ) : err ? (
        <p className="text-sm text-muted-foreground">{err}</p>
      ) : !latest ? (
        <div className="space-y-3">
          <p className="text-sm">
            No briefings yet. Generate one to see where to focus today.
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              disabled={creating}
              onClick={() => void generate()}
            >
              {creating ? 'Generating…' : 'Generate briefing'}
            </Button>
            <Link to="/cfo/briefings" className="text-xs muted underline self-center">
              Open CFO briefing
            </Link>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {latest.safeToSpendSnapshot ? (
            <div>
              <p className="text-xs muted">
                Safe to spend · next {latest.safeToSpendSnapshot.windowDays} days
              </p>
              <p
                className={`text-2xl font-semibold tabular-nums ${
                  latest.safeToSpendSnapshot.isNegative
                    ? 'text-destructive'
                    : ''
                }`}
              >
                {formatMoney(
                  latest.safeToSpendSnapshot.value,
                  latest.safeToSpendSnapshot.currency,
                )}
              </p>
            </div>
          ) : null}

          <p className="text-sm">
            {latest.summary ?? `${openCount} action items pending.`}
          </p>

          {topItems.length > 0 ? (
            <ul className="space-y-1 text-sm">
              {topItems.map((item) => (
                <li
                  key={item.id}
                  className="flex items-baseline justify-between gap-2"
                >
                  <span className="truncate">
                    <span
                      className={`mr-1 inline-block h-2 w-2 rounded-full align-middle ${
                        item.severity === 'action'
                          ? 'bg-destructive'
                          : item.severity === 'watch'
                            ? 'bg-amber-500'
                            : 'bg-muted-foreground'
                      }`}
                      aria-label={item.severity}
                    />
                    {item.link ? (
                      <Link to={item.link} className="hover:underline">
                        {item.title}
                      </Link>
                    ) : (
                      item.title
                    )}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          <div className="flex flex-wrap gap-3 text-xs">
            <Link
              to="/cfo/briefings"
              className="font-semibold text-foreground underline"
            >
              Open full briefing
            </Link>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={creating}
              onClick={() => void generate()}
              className="h-6 px-2 text-xs"
            >
              {creating ? 'Generating…' : 'Refresh'}
            </Button>
          </div>
        </div>
      )}
    </BentoTile>
  )
}

function severityRank(s: 'info' | 'watch' | 'action'): number {
  if (s === 'action') return 3
  if (s === 'watch') return 2
  return 1
}
