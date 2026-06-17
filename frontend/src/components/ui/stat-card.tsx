import * as React from 'react'
import { cn } from '@/lib/utils'
import { Card } from './card'
import {
  DELTA_SIGN_STYLE,
  parseDeltaSign,
  resolveDeltaTone,
  type MetricKind,
} from './delta-tone'

type StatCardProps = React.ComponentProps<typeof Card> & {
  label: React.ReactNode
  value: React.ReactNode
  hint?: React.ReactNode
  delta?: React.ReactNode
  metricKind?: MetricKind
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
      <p className={cn('statValue', 'text-xl font-bold truncate')} title={valueTitle}>
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
