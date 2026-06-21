import { StatCard } from '@connor-adams/designsystem'

export type MetricStatProps = {
  label: string
  value: string
  deltaPct?: number | null
  hint?: string
  loading?: boolean
}

// Format a percentage change as the DS-expected signed delta string ("+1.23%"
// / "-2.50%"). The DS StatCard parses the sign and colors the badge; with
// metricKind="gain" an up move reads green and a down move red.
function formatDeltaPct(deltaPct: number): string {
  return `${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(2)}%`
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
    deltaPct == null || !Number.isFinite(deltaPct) ? undefined : formatDeltaPct(deltaPct)
  return (
    <StatCard
      label={label}
      value={value}
      hint={hint ?? '—'}
      delta={delta}
      metricKind="gain"
    />
  )
}
