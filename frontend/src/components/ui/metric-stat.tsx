import { StatCard } from './stat-card'

export type MetricStatProps = {
  label: string
  value: string
  delta?: number | null
  deltaPct?: number | null
  hint?: string
  loading?: boolean
}

function formatDelta(deltaPct: number): { arrow: string; text: string; color: string } {
  if (deltaPct >= 0) {
    return {
      arrow: '↑',
      text: `+${deltaPct.toFixed(2)}%`,
      color: 'var(--accent-positive)',
    }
  }
  return {
    arrow: '↓',
    text: `${Math.abs(deltaPct).toFixed(2)}%`,
    color: 'var(--accent-warm)',
  }
}

export function MetricStat({ label, value, deltaPct, hint, loading }: MetricStatProps) {
  if (loading) {
    return (
      <div data-loading="true">
        <StatCard label={label} value="…" hint={hint} />
      </div>
    )
  }
  const delta =
    deltaPct == null || !Number.isFinite(deltaPct)
      ? null
      : formatDelta(deltaPct)
  const compositeHint = delta
    ? `${delta.arrow} ${delta.text}${hint ? ` · ${hint}` : ''}`
    : hint
  return (
    <div style={delta ? { borderLeft: `3px solid ${delta.color}` } : undefined}>
      <StatCard label={label} value={value} hint={compositeHint ?? '—'} />
    </div>
  )
}
