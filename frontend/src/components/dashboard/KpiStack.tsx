import * as React from 'react'
import { cn } from '@/lib/utils'

export type KpiItem = {
  label: React.ReactNode
  value: React.ReactNode
  hint?: React.ReactNode
  delta?: React.ReactNode
}

type KpiStackProps = React.ComponentProps<'div'> & {
  items: KpiItem[]
}

export function KpiStack({ items, className, ...props }: KpiStackProps) {
  return (
    <div data-slot="kpi-stack" className={cn('kpiStack', className)} {...props}>
      {items.map((item, idx) => {
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
              <p className="kpiStack__delta">{item.delta}</p>
            )}
          </div>
        )
      })}
    </div>
  )
}
