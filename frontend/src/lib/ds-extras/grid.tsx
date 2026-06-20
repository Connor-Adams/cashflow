import * as React from 'react'

/**
 * Responsive auto-fit/fill grid. Fresh helper — the DS has no Grid primitive.
 * Mirrors the app's prior usage: a token-gapped grid whose tracks floor at
 * `minItemWidth` and grow to fill.
 */
type GridProps = React.ComponentProps<'div'> & {
  minItemWidth?: number
  gap?: 'sm' | 'md' | 'lg'
  fill?: boolean
  /** When true (default), tracks floor at `min(100%, minItemWidth)` so a single
   *  item never overflows a narrow container. When false, tracks are a hard px. */
  responsiveFloor?: boolean
}

const GAP: Record<NonNullable<GridProps['gap']>, string> = {
  sm: 'gap-2',
  md: 'gap-3',
  lg: 'gap-4',
}

export function Grid({
  minItemWidth = 180,
  gap = 'md',
  fill = false,
  responsiveFloor = true,
  className,
  style,
  ...props
}: GridProps) {
  const track = responsiveFloor ? `min(100%, ${minItemWidth}px)` : `${minItemWidth}px`
  const gridTemplateColumns = `repeat(${fill ? 'auto-fill' : 'auto-fit'}, minmax(${track}, 1fr))`
  return (
    <div
      data-slot="grid"
      className={['grid', GAP[gap], className].filter(Boolean).join(' ')}
      style={{ ...style, gridTemplateColumns }}
      {...props}
    />
  )
}
