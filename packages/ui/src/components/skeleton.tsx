import * as React from 'react'
import { cn } from '../lib/cn'

function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn('skeleton-shimmer rounded-md', className)}
      {...props}
    />
  )
}

type SkeletonTextProps = React.ComponentProps<'div'> & {
  lines?: number
}

function SkeletonText({ lines = 3, className, ...props }: SkeletonTextProps) {
  const count = Math.max(1, Math.floor(lines))
  return (
    <div
      data-slot="skeleton-text"
      aria-hidden="true"
      className={cn('flex flex-col gap-2', className)}
      {...props}
    >
      {Array.from({ length: count }).map((_, i) => {
        const isLast = i === count - 1
        return (
          <Skeleton
            key={i}
            className={cn('h-3 w-full', isLast && count > 1 ? 'w-2/3' : '')}
          />
        )
      })}
    </div>
  )
}

type SkeletonRowProps = React.ComponentProps<'tr'> & {
  cols?: number
}

function SkeletonRow({ cols = 1, className, ...props }: SkeletonRowProps) {
  const count = Math.max(1, Math.floor(cols))
  return (
    <tr
      data-slot="skeleton-row"
      aria-hidden="true"
      className={className}
      {...props}
    >
      {Array.from({ length: count }).map((_, i) => (
        <td key={i} className="whitespace-nowrap px-3 py-2.5 align-middle">
          <Skeleton className="h-4 w-full" />
        </td>
      ))}
    </tr>
  )
}

export { Skeleton, SkeletonText, SkeletonRow }
