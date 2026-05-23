import * as React from 'react'
import { cn } from '@/lib/utils'
import {
  DELTA_SIGN_STYLE,
  parseDeltaSign,
  resolveDeltaTone,
  type MetricKind,
} from '@/components/ui/delta-tone'

export type KpiItem = {
  label: React.ReactNode
  value: React.ReactNode
  hint?: React.ReactNode
  delta?: React.ReactNode
  metricKind?: MetricKind
}

type KpiStackProps = React.ComponentProps<'div'> & {
  items: KpiItem[]
}

/**
 * Compact vertical stack of KPI rows. Each row mirrors StatCard's delta
 * sign/tone semantics but renders tighter — used in the bento KPI tile beside
 * the hero. For full-size stat tiles, use StatCard directly.
 */
export function KpiStack({ items, className, ...props }: KpiStackProps) {
  return (
    <div data-slot="kpi-stack" className={cn('kpiStack', className)} {...props}>
      {items.map((item, idx) => {
        const sign = parseDeltaSign(item.delta)
        const tone = resolveDeltaTone(sign, item.metricKind ?? 'neutral')
        const valueTitle =
          typeof item.value === 'string' || typeof item.value === 'number'
            ? String(item.value)
            : undefined
        return (
          <div key={idx} className="kpiStack__row">
            <p className="kpiStack__label">{item.label}</p>
            <p className="kpiStack__value" title={valueTitle}>
              {item.value}
            </p>
            {item.hint && <p className="kpiStack__hint">{item.hint}</p>}
            {item.delta && (
              <p className="kpiStack__delta">
                <span
                  data-slot="kpi-stack-delta"
                  data-sign={sign}
                  data-tone={tone}
                  className="inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs font-semibold"
                  style={DELTA_SIGN_STYLE[tone]}
                >
                  {item.delta}
                </span>
              </p>
            )}
          </div>
        )
      })}
    </div>
  )
}
