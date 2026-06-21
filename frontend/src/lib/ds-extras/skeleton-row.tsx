import * as React from 'react'
import { Skeleton } from '@connor-adams/designsystem'

/**
 * Table loading row: `cols` cells each holding a DS Skeleton block.
 * Fresh helper — the DS ships Skeleton/SkeletonText but no table-row variant.
 */
export function SkeletonRow({
  cols = 1,
  className,
  ...props
}: React.ComponentProps<'tr'> & { cols?: number }) {
  const count = Math.max(1, Math.floor(cols))
  return (
    <tr data-slot="skeleton-row" aria-hidden="true" className={className} {...props}>
      {Array.from({ length: count }).map((_, i) => (
        <td key={i} className="whitespace-nowrap px-3 py-2.5 align-middle">
          <Skeleton w="100%" h={16} />
        </td>
      ))}
    </tr>
  )
}
