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
    // formerly .kpiStack — flex col, full height, gap:0
    <div data-slot="kpi-stack" className={cn('flex h-full flex-col', className)} {...props}>
      {items.map((item, idx) => {
        const valueTitle =
          typeof item.value === 'string' || typeof item.value === 'number'
            ? String(item.value)
            : undefined
        return (
          // formerly .kpiStack__row + .kpiStack__row border-top
          <div
            key={idx}
            className={cn(
              'flex flex-1 flex-col justify-center gap-1 py-2',
              idx > 0 && 'border-t border-[var(--border)]',
            )}
          >
            {/* formerly .kpiStack__label */}
            <p className="m-0 text-xs font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
              {item.label}
            </p>
            {/* formerly .kpiStack__value */}
            <p className="m-0 truncate text-xl font-semibold tabular-nums text-[var(--foreground)]" title={valueTitle}>
              {item.value}
            </p>
            {/* formerly .kpiStack__hint */}
            {item.hint && (
              <p className="m-0 text-xs text-[var(--muted-foreground)]">{item.hint}</p>
            )}
            {/* formerly .kpiStack__delta */}
            {item.delta && (
              <p className="m-0 mt-1">{item.delta}</p>
            )}
          </div>
        )
      })}
    </div>
  )
}
