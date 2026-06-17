import * as React from 'react'
import { cn } from '@/lib/utils'

type GridProps = React.ComponentProps<'div'> & {
  minItemWidth?: number
  gap?: 'sm' | 'md' | 'lg'
  fill?: boolean
  responsiveFloor?: boolean
}

const GAP: Record<NonNullable<GridProps['gap']>, string> = {
  sm: 'gap-2',
  md: 'gap-3',
  lg: 'gap-4',
}

function Grid({
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
      className={cn('grid', GAP[gap], className)}
      style={{ gridTemplateColumns, ...style }}
      {...props}
    />
  )
}

export { Grid }
export type { GridProps }
