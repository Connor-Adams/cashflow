import * as React from 'react'
import { cn } from '@/lib/utils'

export type BentoSpan = 3 | 4 | 6 | 8 | 12
export type BentoRows = 1 | 2

/**
 * Responsive column-span classes per authoring span. Literal strings (no
 * template interpolation) so the Tailwind JIT picks them up.
 *
 * Tiers:
 *   base (<640):     stack — every tile full-width
 *   sm   (≥640):     6-col grid
 *   lg   (≥1024):    12-col grid (current default authoring width)
 *   3xl  (≥1440):    12-col grid with halved spans → 3-4 wide rows
 *
 * Container uses `grid-flow-row-dense` so smaller tiles auto-fill earlier
 * gaps; DOM order is preserved for a11y.
 */
const SPAN_CLASSES: Record<BentoSpan, string> = {
  3:  'col-span-full sm:col-span-3 lg:col-span-3 3xl:col-span-2',
  4:  'col-span-full sm:col-span-3 lg:col-span-4 3xl:col-span-3',
  6:  'col-span-full sm:col-span-6 lg:col-span-6 3xl:col-span-3',
  8:  'col-span-full sm:col-span-6 lg:col-span-8 3xl:col-span-6',
  12: 'col-span-full sm:col-span-6 lg:col-span-12 3xl:col-span-12',
}

const ROW_CLASSES: Record<BentoRows, string> = {
  1: 'row-span-1',
  2: 'row-span-2',
}

type BentoTileProps = React.ComponentProps<'section'> & {
  /** Column span at the wide (12-col) authoring breakpoint. Collapses at narrow widths and halves at 3xl. */
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
 * driven by responsive Tailwind classes from SPAN_CLASSES / ROW_CLASSES.
 * The container is a `<section>` so each tile is a landmark.
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
      data-variant={variant}
      className={cn(
        'bentoTile',
        SPAN_CLASSES[span],
        ROW_CLASSES[rows],
        variant === 'hero' && 'bentoTile--hero',
        className,
      )}
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
