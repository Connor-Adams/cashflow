import * as React from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

export type BentoSpan = 3 | 4 | 6 | 8 | 12
export type BentoRows = 1 | 2
export type BentoVariant = 'default' | 'hero' | 'gradient' | 'warning' | 'destructive'

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
   *  - 'hero': flat anchor tile (slightly emphasized chrome).
   *  - 'gradient': full orange→pink hero gradient with white text (the one
   *    deliberate gradient surface — e.g. positive Safe-to-spend).
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
  /** Optional leading icon, rendered in a tinted circular badge before the
   *  label. Use it to give a tile a splash of color (e.g. a bell on the
   *  review banner). The badge tint follows the variant. */
  icon?: React.ReactNode
  /** When provided, renders a dismiss (✕) button at the top-right of the
   *  header. The caller owns the dismissed state. */
  onDismiss?: () => void
  /** Accessible label for the dismiss button. Defaults to "Dismiss". */
  dismissLabel?: string
}

/**
 * Badge tint per variant — a saturated circle behind the leading icon so the
 * tile reads with a pop of color without flooding the whole surface.
 */
const VARIANT_ICON_STYLE: Record<BentoVariant, React.CSSProperties> = {
  default: {
    background: 'color-mix(in srgb, var(--primary) 16%, var(--card))',
    color: 'var(--primary)',
  },
  hero: {
    background: 'color-mix(in srgb, var(--primary) 16%, var(--card))',
    color: 'var(--primary)',
  },
  gradient: {
    background: 'color-mix(in srgb, var(--zinc-50) 22%, transparent)',
    color: '#fff',
  },
  warning: {
    background: 'color-mix(in srgb, var(--accent-warm) 22%, var(--card))',
    color: 'var(--accent-warm)',
  },
  destructive: {
    background: 'color-mix(in srgb, var(--danger) 20%, var(--card))',
    color: 'var(--danger)',
  },
}

/**
 * Chrome wrapper for a single bento dashboard tile. Layout/grid placement is
 * driven by responsive Tailwind classes from SPAN_CLASSES / ROW_CLASSES.
 * The container is a `<section>` so each tile is a landmark.
 */
/**
 * Inline styles for the gradient variant — values that cannot be expressed
 * as static Tailwind utilities because they reference CSS custom properties
 * in a way the JIT cannot statically analyze.
 */
const GRADIENT_STYLE: React.CSSProperties = {
  background: 'var(--gradient-hero)',
  borderColor: 'transparent',
  color: '#fff',
}

export function BentoTile({
  span,
  rows = 2,
  variant = 'default',
  label,
  description,
  actions,
  icon,
  onDismiss,
  dismissLabel = 'Dismiss',
  className,
  style,
  children,
  ...props
}: BentoTileProps) {
  const hasHeader =
    label != null ||
    description != null ||
    actions != null ||
    icon != null ||
    onDismiss != null
  const variantStyle = VARIANT_STYLE[variant]

  // Base tile styles reproduced from the former .bentoTile App.css rule.
  // The border-color, background, and box-shadow reference CSS tokens so
  // they are kept as inline styles (arbitrary values would be less readable
  // and the token references are already the canonical form).
  const baseTileStyle: React.CSSProperties = {
    borderColor: 'color-mix(in srgb, var(--border) 88%, var(--zinc-50) 4%)',
    background: 'var(--card)',
    boxShadow: 'var(--shadow)',
    minWidth: 0,
  }

  // Gradient variant overrides background + borderColor + text color.
  const gradientOverride = variant === 'gradient' ? GRADIENT_STYLE : undefined

  // Merge order: baseTileStyle < variantStyle (warning/destructive) < gradientOverride < caller style
  const mergedStyle: React.CSSProperties = {
    ...baseTileStyle,
    ...variantStyle,
    ...gradientOverride,
    ...style,
  }

  return (
    <section
      data-slot="bento-tile"
      data-variant={variant}
      className={cn(
        // Base tile chrome (formerly .bentoTile)
        'flex flex-col gap-3 rounded-lg border p-4 sm:p-5',
        SPAN_CLASSES[span],
        ROW_CLASSES[rows],
        className,
      )}
      style={mergedStyle}
      {...props}
    >
      {hasHeader && (
        // formerly .bentoTile__header
        <header className="flex items-start justify-between gap-3">
          {icon != null && (
            // Tinted circular badge — the tile's splash of color.
            <span
              className="flex size-9 shrink-0 items-center justify-center rounded-full"
              style={VARIANT_ICON_STYLE[variant]}
              aria-hidden="true"
            >
              {icon}
            </span>
          )}
          {/* formerly .bentoTile__heading */}
          <div className="min-w-0 flex-1">
            {label && (
              // formerly .bentoTile__label
              <p
                className="m-0 text-sm font-semibold"
                style={
                  variant === 'gradient'
                    ? { color: 'color-mix(in srgb, var(--zinc-50) 92%, transparent)' }
                    : { color: 'var(--foreground)' }
                }
              >
                {label}
              </p>
            )}
            {description && (
              // formerly .bentoTile__description
              <p
                className="mt-1 mb-0 text-xs"
                style={
                  variant === 'gradient'
                    ? { color: 'color-mix(in srgb, var(--zinc-50) 92%, transparent)' }
                    : { color: 'var(--muted-foreground)' }
                }
              >
                {description}
              </p>
            )}
          </div>
          {/* formerly .bentoTile__actions */}
          {(actions || onDismiss) && (
            <div className="flex shrink-0 items-center gap-2">
              {actions}
              {onDismiss && (
                <button
                  type="button"
                  onClick={onDismiss}
                  aria-label={dismissLabel}
                  className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  style={variant === 'gradient' ? { color: '#fff' } : undefined}
                >
                  <X className="size-4" aria-hidden="true" />
                </button>
              )}
            </div>
          )}
        </header>
      )}
      {/* formerly .bentoTile__body */}
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </section>
  )
}
