import * as React from 'react'
import { cn } from '@/lib/utils'
import { Card } from './card'

// Semantic intent of the metric a StatCard reports on. Drives how the delta
// color is chosen: for spend metrics, less is good, so a positive (up) delta
// reads as bad (red). For gain metrics, more is good, so up reads as green.
// Neutral metrics (transfers, row counts) never color the delta because the
// direction isn't inherently good or bad.
export type MetricKind = 'gain' | 'spend' | 'neutral'

type StatCardProps = React.ComponentProps<typeof Card> & {
  label: React.ReactNode
  value: React.ReactNode
  hint?: React.ReactNode
  delta?: React.ReactNode
  metricKind?: MetricKind
}

type DeltaSign = 'positive' | 'negative' | 'neutral'
type DeltaTone = 'positive' | 'negative' | 'neutral'

function parseDeltaSign(delta: React.ReactNode): DeltaSign {
  if (delta == null) return 'neutral'
  const text = typeof delta === 'string' || typeof delta === 'number' ? String(delta) : ''
  if (!text) return 'neutral'
  const trimmed = text.trim()
  // Find the first explicit sign that introduces a numeric chunk, tolerating
  // a leading descriptor (e.g. "vs previous period: ") and currency symbols
  // between the sign and the digits.
  const signMatch = trimmed.match(/([+\-−])\s*[^\d+\-−]*\d/)
  if (signMatch) {
    return signMatch[1] === '+' ? 'positive' : 'negative'
  }
  // No explicit sign — fall back to coercing the first numeric token.
  const match = trimmed.match(/\d+(\.\d+)?/)
  if (!match) return 'neutral'
  const num = Number(match[0])
  if (!Number.isFinite(num) || num === 0) return 'neutral'
  return num > 0 ? 'positive' : 'negative'
}

// Map the parsed numeric sign + the metric's semantic intent to the styling
// tone. For 'gain' metrics the sign and tone agree (up is good → green). For
// 'spend' metrics the tone is inverted (up is bad → red). For 'neutral'
// metrics every delta renders muted regardless of sign — the direction is
// directionally meaningful but not emotionally good or bad.
function resolveDeltaTone(sign: DeltaSign, kind: MetricKind): DeltaTone {
  if (kind === 'neutral') return 'neutral'
  if (sign === 'neutral') return 'neutral'
  if (kind === 'spend') {
    return sign === 'positive' ? 'negative' : 'positive'
  }
  return sign
}

const DELTA_SIGN_STYLE: Record<DeltaTone, React.CSSProperties> = {
  positive: {
    background: 'color-mix(in srgb, var(--accent-green) 16%, transparent)',
    borderColor: 'color-mix(in srgb, var(--accent-green) 45%, var(--border))',
    color: 'var(--accent-green)',
  },
  negative: {
    background: 'color-mix(in srgb, var(--danger) 14%, transparent)',
    borderColor: 'color-mix(in srgb, var(--danger) 45%, var(--border))',
    color: 'var(--danger)',
  },
  neutral: {
    background: 'transparent',
    borderColor: 'var(--border)',
    color: 'var(--muted-foreground)',
  },
}

function StatCard({
  label,
  value,
  hint,
  delta,
  metricKind = 'gain',
  className,
  ...props
}: StatCardProps) {
  const sign = parseDeltaSign(delta)
  const tone = resolveDeltaTone(sign, metricKind)
  const valueTitle = typeof value === 'string' || typeof value === 'number' ? String(value) : undefined
  return (
    <Card data-slot="stat-card" className={cn('mb-0', className)} {...props}>
      <p className="statLabel">{label}</p>
      <p className={cn('statValue', 'text-xl font-semibold truncate')} title={valueTitle}>
        {value}
      </p>
      {hint ? (
        <p className={cn('muted statHint', 'text-xs')}>{hint}</p>
      ) : null}
      {delta ? (
        <p className="statDelta m-0">
          <span
            data-slot="stat-card-delta"
            data-sign={sign}
            data-tone={tone}
            data-metric-kind={metricKind}
            className="inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs font-semibold"
            style={DELTA_SIGN_STYLE[tone]}
          >
            {delta}
          </span>
        </p>
      ) : null}
    </Card>
  )
}

export { StatCard }
