import * as React from 'react'
import { cn } from '@/lib/utils'

export type BentoSpan = 3 | 4 | 6 | 8 | 12
export type BentoRows = 1 | 2

type BentoTileProps = React.ComponentProps<'section'> & {
  /** Column span at the wide (12-col) breakpoint. Collapses at narrow widths. */
  span: BentoSpan
  /** Row span (1 = compact, 2 = standard tile height). */
  rows?: BentoRows
  /** Visual variant. 'hero' gets a subtle amber-tinted gradient at the top edge. */
  variant?: 'default' | 'hero'
  /** Optional inline label rendered at the top of the tile. Use this for chart
   *  titles instead of `<h2>` so chrome stays consistent across tiles. */
  label?: React.ReactNode
  /** Optional description rendered below the label. */
  description?: React.ReactNode
  /** Optional right-aligned actions in the header row. */
  actions?: React.ReactNode
}

/**
 * Chrome wrapper for a single bento dashboard tile. Layout/grid placement is
 * driven by data-attributes consumed by `.bentoTile[data-span]` selectors in
 * App.css. The container is a `<section>` so each tile is a landmark.
 */
export function BentoTile({
  span,
  rows = 2,
  variant = 'default',
  label,
  description,
  actions,
  className,
  children,
  ...props
}: BentoTileProps) {
  const hasHeader = label != null || description != null || actions != null
  return (
    <section
      data-slot="bento-tile"
      data-span={span}
      data-rows={rows}
      data-variant={variant}
      className={cn('bentoTile', variant === 'hero' && 'bentoTile--hero', className)}
      {...props}
    >
      {hasHeader && (
        <header className="bentoTile__header">
          <div className="bentoTile__heading">
            {label && <p className="bentoTile__label">{label}</p>}
            {description && <p className="bentoTile__description">{description}</p>}
          </div>
          {actions && <div className="bentoTile__actions">{actions}</div>}
        </header>
      )}
      <div className="bentoTile__body">{children}</div>
    </section>
  )
}
