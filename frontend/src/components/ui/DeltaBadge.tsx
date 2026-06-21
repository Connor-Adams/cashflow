import {
  DELTA_SIGN_STYLE,
  resolveDeltaTone,
  type DeltaSign,
  type MetricKind,
} from '@/components/ui/delta-tone'
import { formatCurrency } from '@/lib/formatCurrency'

export type DeltaBadgeProps = {
  delta: number
  metricKind: MetricKind
  currency?: string
  className?: string
}

export function DeltaBadge({ delta, metricKind, currency, className }: DeltaBadgeProps) {
  const sign: DeltaSign = delta > 0 ? 'positive' : delta < 0 ? 'negative' : 'neutral'
  const tone = resolveDeltaTone(sign, metricKind)
  const arrow = sign === 'positive' ? '▲' : sign === 'negative' ? '▼' : '—'
  const formatted = currency
    ? formatCurrency(Math.abs(delta), currency)
    : String(Math.abs(Math.round(delta)))

  return (
    <span
      data-slot="delta-badge"
      data-sign={sign}
      data-tone={tone}
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-semibold tabular-nums ${className ?? ''}`}
      style={DELTA_SIGN_STYLE[tone]}
    >
      <span aria-hidden="true">{arrow}</span>
      {formatted}
    </span>
  )
}
