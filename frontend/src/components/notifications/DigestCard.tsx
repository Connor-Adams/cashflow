import { useState } from 'react'
import { ChevronDown, ChevronRight, TrendingDown, TrendingUp } from 'lucide-react'
import { Button } from '@cashflow/ui'
import { formatCurrency } from '@/lib/formatCurrency'
import type {
  DigestCategoryDelta,
  DigestInsight,
  DigestUpcomingExpectation,
  Notification,
  WeeklyDigestPayload,
} from '@/types/api'

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

/** Color class for a spend delta: up = bad (danger), down = good (success). */
function deltaColor(delta: number): string {
  if (delta > 0) return 'text-danger'
  if (delta < 0) return 'text-success'
  return 'text-muted-foreground'
}

const SECTION_HEADING =
  'mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground'

function CategoryDeltasSection({ deltas }: { deltas: DigestCategoryDelta[] }) {
  if (deltas.length === 0) return null
  return (
    <section>
      <h3 className={SECTION_HEADING}>Category changes</h3>
      <ul className="space-y-1">
        {deltas.map((c) => (
          <li key={c.category} className="flex items-baseline justify-between gap-2 text-sm">
            <span className="truncate text-foreground">{c.category}</span>
            <span className="shrink-0 tabular-nums">
              <span className="font-medium">{formatCurrency(c.total, c.currency)}</span>{' '}
              <span className={deltaColor(c.delta)}>
                ({c.delta > 0 ? '+' : ''}
                {formatCurrency(c.delta, c.currency)})
              </span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function InsightsSection({
  insights,
  openCount,
}: {
  insights: DigestInsight[]
  openCount?: number
}) {
  if (insights.length === 0) return null
  const suffix = typeof openCount === 'number' && openCount > 0 ? ` (${openCount})` : ''
  return (
    <section>
      <h3 className={SECTION_HEADING}>Top open insights{suffix}</h3>
      <ul className="space-y-1">
        {insights.map((i) => (
          <li key={i.id} className="truncate text-sm text-foreground">
            {i.title}
          </li>
        ))}
      </ul>
    </section>
  )
}

function UpcomingSection({ items }: { items: DigestUpcomingExpectation[] }) {
  if (items.length === 0) return null
  return (
    <section>
      <h3 className={SECTION_HEADING}>Coming up next week</h3>
      <ul className="space-y-1">
        {items.map((e) => (
          <li key={e.id} className="flex items-baseline justify-between gap-2 text-sm">
            <span className="truncate text-foreground">{e.name}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {formatCurrency(e.amount, e.currency)} · {e.dueDate}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function ExpandedBody({ data }: { data: WeeklyDigestPayload }) {
  const categoryDeltas = data.categoryDeltas ?? []
  const topInsights = data.topInsights ?? []
  const upcoming = data.upcomingExpectations ?? []
  return (
    <div className="space-y-4 border-t border-border px-4 py-3">
      <CategoryDeltasSection deltas={categoryDeltas} />
      <InsightsSection insights={topInsights} openCount={data.openInsightCount} />
      <UpcomingSection items={upcoming} />
    </div>
  )
}

function isEnriched(data: WeeklyDigestPayload): boolean {
  return (
    typeof data.netChange === 'number' ||
    (data.categoryDeltas?.length ?? 0) > 0 ||
    (data.topInsights?.length ?? 0) > 0 ||
    (data.upcomingExpectations?.length ?? 0) > 0
  )
}

export function DigestCard({ notification, defaultExpanded = false }: Props) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const data = (notification.dataJson ?? {}) as WeeklyDigestPayload
  const currency = data.currency ?? 'CAD'
  const hasNet = typeof data.netChange === 'number'
  const enriched = isEnriched(data)

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

      {expanded && enriched && <ExpandedBody data={data} />}
    </div>
  )
}
