import { Badge } from '@cashflow/ui'

/**
 * Visual badge for credit-card utilization (#437).
 *
 * Tiers:
 *  - 0–30%      green       "X% used"
 *  - 30–70%     amber       "X% used"
 *  - 70–90%     orange      "X% used"
 *  - 90–100%    red         "X% used"
 *  - >100%      red         ">100% — over limit"
 *
 * Render nothing when pct is null (no limit set or card closed). Caller is
 * responsible for the "Set credit limit" CTA in the no-limit case.
 *
 * Tailwind v4 JIT requires literal class names — variant lookups are tables
 * keyed by tier, not constructed at render time.
 */

type Tier = 'low' | 'med' | 'high' | 'critical' | 'over'

const TIER_CLASSES: Record<Tier, string> = {
  low: 'border-transparent bg-success-bg text-positive',
  med: 'border-transparent bg-warning-bg text-warning',
  high: 'border-transparent bg-warning-bg text-warning',
  critical: 'border-transparent bg-danger-bg text-danger',
  over: 'border-transparent bg-danger-bg text-danger',
}

function tierFor(pct: number): Tier {
  if (pct > 100) return 'over'
  if (pct >= 90) return 'critical'
  if (pct >= 70) return 'high'
  if (pct >= 30) return 'med'
  return 'low'
}

export function UtilizationBadge({
  utilizationPct,
}: {
  utilizationPct: number | null | undefined
}) {
  if (utilizationPct == null || !Number.isFinite(utilizationPct)) return null
  const tier = tierFor(utilizationPct)
  const label =
    tier === 'over'
      ? '>100% — over limit'
      : `${Math.round(utilizationPct)}% used`
  return (
    <Badge
      className={TIER_CLASSES[tier]}
      title={
        tier === 'over'
          ? 'Balance exceeds the credit limit. Over-limit fees may apply.'
          : undefined
      }
    >
      {label}
    </Badge>
  )
}
