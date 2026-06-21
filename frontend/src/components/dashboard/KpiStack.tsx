import * as React from 'react'
import { StatCard } from '@connor-adams/designsystem'
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

// Neutralize StatCard's standalone card chrome (background/shadow/radius/padding)
// so each row reads as a stacked row inside the shared BentoTile rather than a
// card-within-a-card. The row separator (top border after the first row) is also
// applied via style because StatCard sets `border` inline, and inline style wins
// over a Tailwind `border-t` class. Everything DS owns — label/value/hint/delta
// typography — comes from StatCard itself; only layout is overridden here.
const ROW_CHROME_RESET: React.CSSProperties = {
  background: 'transparent',
  boxShadow: 'none',
  borderRadius: 0,
  padding: 0,
}

export function KpiStack({ items, className, ...props }: KpiStackProps) {
  return (
    // formerly .kpiStack — flex col, full height, gap:0
    <div data-slot="kpi-stack" className={cn('flex h-full flex-col', className)} {...props}>
      {items.map((item, idx) => (
        // Stacked row: fill height evenly, center content, top border after the
        // first row (replaces .kpiStack__row + border-top).
        <StatCard
          key={idx}
          label={item.label}
          value={item.value}
          hint={item.hint}
          delta={item.delta}
          className="min-w-0 flex-1 justify-center py-2"
          style={{
            ...ROW_CHROME_RESET,
            border: 'none',
            borderTop: idx > 0 ? '1px solid var(--border)' : 'none',
          }}
        />
      ))}
    </div>
  )
}
