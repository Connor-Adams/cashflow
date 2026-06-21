import * as React from 'react'
import { Button, CardDescription, CardHeader, CardTitle, Icon } from '@connor-adams/designsystem'
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
 * Surface chrome per variant, expressed entirely through DS token utilities
 * (no raw `var()` inline styles). The base surface mirrors the DS `Card`
 * (`bg-card`, `border-border`, `--shadow`); the alert-shaped variants tint
 * with a token-opacity wash that reads the same as the DS `Alert` recipe.
 */
const VARIANT_SURFACE: Record<BentoVariant, string> = {
  default:     'bg-card border-border text-card-foreground shadow-[var(--shadow)]',
  hero:        'bg-card border-border text-card-foreground shadow-[var(--shadow)]',
  gradient:    'bg-[var(--gradient-hero)] border-transparent text-white shadow-[var(--shadow)]',
  warning:     'bg-warning/10 border-warning/45 text-card-foreground shadow-[var(--shadow)]',
  destructive: 'bg-danger/10 border-danger/45 text-card-foreground shadow-[var(--shadow)]',
}

/**
 * Badge tint per variant — a saturated circle behind the leading icon so the
 * tile reads with a pop of color without flooding the whole surface. Token
 * utilities only (opacity wash over the semantic colour).
 */
const VARIANT_ICON_BADGE: Record<BentoVariant, string> = {
  default:     'bg-primary/15 text-primary',
  hero:        'bg-primary/15 text-primary',
  gradient:    'bg-white/20 text-white',
  warning:     'bg-warning/20 text-warning',
  destructive: 'bg-danger/20 text-danger',
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
 * Chrome wrapper for a single bento dashboard tile. Composes the DS `Card`
 * family (`CardHeader` / `CardTitle` / `CardDescription`) for the header and
 * the DS `Button` for the dismiss control; the surface mirrors the DS `Card`
 * via token utilities. Layout/grid placement is driven by responsive Tailwind
 * classes from SPAN_CLASSES / ROW_CLASSES. The container stays a `<section>`
 * so each tile remains a landmark when a caller passes `aria-label`.
 */
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
  children,
  ...props
}: BentoTileProps) {
  const hasHeader =
    label != null ||
    description != null ||
    actions != null ||
    icon != null ||
    onDismiss != null
  const onGradient = variant === 'gradient'

  return (
    <section
      data-slot="bento-tile"
      data-variant={variant}
      className={cn(
        // Base tile chrome — DS Card surface via token utilities.
        'flex min-w-0 flex-col gap-3 rounded-lg border p-4 sm:p-5',
        VARIANT_SURFACE[variant],
        SPAN_CLASSES[span],
        ROW_CLASSES[rows],
        className,
      )}
      {...props}
    >
      {hasHeader && (
        <header className="flex items-start justify-between gap-3">
          {icon != null && (
            // Tinted circular badge — the tile's splash of color.
            <span
              className={cn(
                'flex size-9 shrink-0 items-center justify-center rounded-full',
                VARIANT_ICON_BADGE[variant],
              )}
              aria-hidden="true"
            >
              {icon}
            </span>
          )}
          {(label || description) && (
            // DS CardHeader stacks the title + description. The DS sub-parts pin
            // their own typography inline (headline-size title, body-size
            // description); the bento tile wants the compact 14px/12px scale, so
            // fontSize is overridden here. Colour follows the tile: the title
            // inherits the surface text colour (card-foreground, or white on the
            // gradient); the description stays muted (a white wash on gradient).
            <CardHeader className="min-w-0 flex-1" style={{ gap: 4, marginBottom: 0 }}>
              {label && (
                <CardTitle
                  className="m-0 font-semibold"
                  style={{ fontSize: '0.875rem', color: 'inherit' }}
                >
                  {label}
                </CardTitle>
              )}
              {description && (
                <CardDescription
                  className="m-0"
                  style={
                    onGradient
                      ? {
                          fontSize: '0.75rem',
                          // White wash on the gradient via the DS token (no raw
                          // rgb literal); color-mix has no Tailwind utility.
                          color: 'color-mix(in oklch, var(--primary-foreground) 90%, transparent)',
                        }
                      : { fontSize: '0.75rem' }
                  }
                >
                  {description}
                </CardDescription>
              )}
            </CardHeader>
          )}
          {(actions || onDismiss) && (
            <div className="flex shrink-0 items-center gap-2">
              {actions}
              {onDismiss && (
                <Button
                  variant={onGradient ? 'secondary' : 'outline'}
                  size="icon"
                  onClick={onDismiss}
                  aria-label={dismissLabel}
                  title={dismissLabel}
                  className={cn(
                    'shrink-0 transition-transform hover:scale-110',
                    onGradient
                      ? 'border-white/40 bg-white/15 text-white hover:bg-white/25'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                  // Size the chip to a 28px round affordance. Numeric inline
                  // styles only (no raw var()) — they override the DS Button's
                  // default 40px icon footprint without re-introducing tokens.
                  style={{ height: 28, width: 28, padding: 0, borderRadius: 9999 }}
                >
                  <Icon name="x" className="size-4" aria-hidden="true" />
                </Button>
              )}
            </div>
          )}
        </header>
      )}
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </section>
  )
}
