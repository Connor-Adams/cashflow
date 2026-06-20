import * as React from 'react'
import { EmptyState } from '@connor-adams/designsystem'

/**
 * Table-scoped empty state: a single full-width row wrapping the DS EmptyState.
 * Fresh helper — the DS ships EmptyState but no table-row variant.
 */
export function EmptyTableRow({
  colSpan,
  title,
  description,
}: {
  colSpan: number
  title: React.ReactNode
  description?: React.ReactNode
}) {
  return (
    <tr>
      <td colSpan={colSpan} className="whitespace-normal align-top px-4 py-5">
        <EmptyState title={title} description={description} />
      </td>
    </tr>
  )
}
