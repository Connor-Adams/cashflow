import { useState } from 'react'
import { ChevronDown, ChevronRight, TrendingDown, TrendingUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatCurrency } from '@/lib/formatCurrency'
import type { Notification, WeeklyDigestPayload } from '@/types/api'

/**
 * Expandable weekly-digest card (issue #796, AC #11/#12).
 *
 * Renders a `digest.weekly` Notification entirely from its persisted
 * `dataJson` — no follow-up network request. Collapsed shows the title and the
 * week's net cash change; expanded reveals the per-category deltas, the top-3
 * open insights, and the expectations due in the next week.
 *
 * Degrades gracefully: a digest persisted before #796 (no `categoryDeltas` /
 * `netChange` / insight / expectation fields) renders the headline only and
 * omits the missing sections — it never throws.
 */
type Props = {
  notification: Notification
  /** Start expanded (deep-link from a push tap: `/?digest=expand`). */
  defaultExpanded?: boolean
}

function netChangeTone(net: number): { Icon: typeof TrendingUp; color: string } {
  // Positive net = cash added (good, up); negative = cash out (down).
  return net >= 0
    ? { Icon: TrendingUp, color: 'text-success' }
    : { Icon: TrendingDown, color: 'text-danger' }
}

export function DigestCard({ notification, defaultExpanded = false }: Props) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const data = (notification.dataJson ?? {}) as WeeklyDigestPayload
  const currency = data.currency ?? 'CAD'

  const hasNet = typeof data.netChange === 'number'
  const categoryDeltas = data.categoryDeltas ?? []
  const topInsights = data.topInsights ?? []
  const upcoming = data.upcomingExpectations ?? []
  // "Enriched" = at least one #796 section is present. When false we show the
  // headline-only degraded card.
  const enriched =
    hasNet || categoryDeltas.length > 0 || topInsights.length > 0 || upcoming.length > 0

  const Chevron = expanded ? ChevronDown : ChevronRight
  const { Icon: NetIcon, color: netColor } = hasNet
    ? netChangeTone(data.netChange as number)
    : { Icon: TrendingUp, color: 'text-muted-foreground' }

  return (
    <div className="rounded-md border border-border bg-card">
      <Button
        type="button"
        variant="ghost"
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        data-testid="digest-card-toggle"
      >
        <Chevron size={16} className="shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-foreground">
            {notification.title}
          </span>
          {hasNet ? (
            <span className={`flex items-center gap-1 text-xs font-medium ${netColor}`}>
              <NetIcon size={13} aria-hidden="true" />
              Net {formatCurrency(data.netChange as number, currency)} this week
            </span>
          ) : (
            <span className="block truncate text-xs text-muted-foreground">
              {notification.body}
            </span>
          )}
        </span>
      </Button>

      {expanded && !enriched && (
        <p className="border-t border-border px-4 py-3 text-sm text-muted-foreground">
          This digest summary is unavailable — open the dashboard for current figures.
        </p>
      )}

      {expanded && enriched && (
        <div className="space-y-4 border-t border-border px-4 py-3">
          {categoryDeltas.length > 0 && (
            <section>
              <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Category changes
              </h3>
              <ul className="space-y-1">
                {categoryDeltas.map((c) => (
                  <li
                    key={c.category}
                    className="flex items-baseline justify-between gap-2 text-sm"
                  >
                    <span className="truncate text-foreground">{c.category}</span>
                    <span className="shrink-0 tabular-nums">
                      <span className="font-medium">{formatCurrency(c.total, c.currency)}</span>{' '}
                      <span
                        className={
                          c.delta > 0
                            ? 'text-danger'
                            : c.delta < 0
                              ? 'text-success'
                              : 'text-muted-foreground'
                        }
                      >
                        ({c.delta > 0 ? '+' : ''}
                        {formatCurrency(c.delta, c.currency)})
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {topInsights.length > 0 && (
            <section>
              <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Top open insights
                {typeof data.openInsightCount === 'number' && data.openInsightCount > 0
                  ? ` (${data.openInsightCount})`
                  : ''}
              </h3>
              <ul className="space-y-1">
                {topInsights.map((i) => (
                  <li key={i.id} className="truncate text-sm text-foreground">
                    {i.title}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {upcoming.length > 0 && (
            <section>
              <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Coming up next week
              </h3>
              <ul className="space-y-1">
                {upcoming.map((e) => (
                  <li
                    key={e.id}
                    className="flex items-baseline justify-between gap-2 text-sm"
                  >
                    <span className="truncate text-foreground">{e.name}</span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {formatCurrency(e.amount, e.currency)} · {e.dueDate}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  )
}
