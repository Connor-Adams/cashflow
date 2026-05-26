import * as React from 'react'
import { cn } from '@/lib/utils'

export type BentoSpan = 3 | 4 | 6 | 8 | 12
export type BentoRows = 1 | 2
export type BentoVariant = 'default' | 'hero' | 'warning' | 'destructive'

/**
 * Responsive column-span classes per authoring span. Literal strings (no
 * template interpolation) so the Tailwind JIT picks them up.
 *
 * Tiers:
 *   base (<640):     stack — every tile full-width
 *   sm   (≥640):     6-col grid
 *   lg   (≥1024):    12-col grid (authoring width)
 *   3xl  (≥1440):    same 12-col layout, wider container
 *
 * Spans stay constant at lg and 3xl so authored pairs (e.g. 8+4, 6+6)
 * keep summing to 12. Halving at 3xl previously broke the parity and
 * left 2-3 column holes between tiles.
 */
const SPAN_CLASSES: Record<BentoSpan, string> = {
  3:  'col-span-full sm:col-span-3 lg:col-span-3',
  4:  'col-span-full sm:col-span-3 lg:col-span-4',
  6:  'col-span-full sm:col-span-6 lg:col-span-6',
  8:  'col-span-full sm:col-span-6 lg:col-span-8',
  12: 'col-span-full sm:col-span-6 lg:col-span-12',
}

const ROW_CLASSES: Record<BentoRows, string> = {
  1: 'row-span-1',
  2: 'row-span-2',
}

/**
 * Inline tint styles for alert-shaped variants. Mirrors the color-mix
 * recipe used by the `Alert` component so a "this is a warning" or "this
 * is critical" tile reads the same regardless of which chrome wraps it.
 */
const VARIANT_STYLE: Partial<Record<BentoVariant, React.CSSProperties>> = {
  warning: {
    background: 'color-mix(in srgb, var(--accent-warm) 12%, var(--card))',
    borderColor: 'color-mix(in srgb, var(--accent-warm) 45%, var(--border))',
  },
  destructive: {
    background: 'color-mix(in srgb, var(--danger) 10%, var(--card))',
    borderColor: 'color-mix(in srgb, var(--danger) 42%, var(--border))',
  },
}

type BentoTileProps = React.ComponentProps<'section'> & {
  /** Column span at the wide (12-col) authoring breakpoint. Collapses at narrow widths and halves at 3xl. */
  span: BentoSpan
  /** Row span (1 = compact, 2 = standard tile height). */
  rows?: BentoRows
  /** Visual variant.
   *  - 'hero': subtle amber gradient (anchor tile).
   *  - 'warning' / 'destructive': alert-shaped tint (used for tiles that
   *    replaced standalone Alert/banner components).
   */
  variant?: BentoVariant
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
  style,
  children,
  ...props
}: BentoTileProps) {
  const hasHeader = label != null || description != null || actions != null
  const variantStyle = VARIANT_STYLE[variant]
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
      style={variantStyle ? { ...variantStyle, ...style } : style}
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
