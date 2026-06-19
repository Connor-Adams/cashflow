import * as React from 'react'
import { cn } from '../lib/cn'

type EmptyStateProps = Omit<React.ComponentProps<'div'>, 'title'> & {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
}

function EmptyState({ title, description, actions, className, ...props }: EmptyStateProps) {
  return (
    <div
      data-slot="empty-state"
      className={cn('rounded-lg border border-border bg-muted/20 p-4 text-sm', className)}
      {...props}
    >
      <p className="emptyState mb-1 font-semibold">{title}</p>
      {description ? <p className="muted mb-0">{description}</p> : null}
      {actions ? <div className="mt-3 flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  )
}

function EmptyTableRow({
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
      <td colSpan={colSpan} className="emptyStateCell">
        <EmptyState title={title} description={description} />
      </td>
    </tr>
  )
}

export { EmptyState, EmptyTableRow }
