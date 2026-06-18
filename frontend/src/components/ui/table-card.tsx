import * as React from 'react'
import { cn } from '@/lib/utils'
import { Card } from './card'
import { SectionHeader } from './section-header'
import { Table } from './table'

type TableCardProps = {
  title?: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  maxHeight?: string
  stickyHeader?: boolean
  className?: string
  'aria-label'?: string
  children: React.ReactNode
}

function TableCard({
  title,
  description,
  actions,
  maxHeight = '72vh',
  stickyHeader = true,
  className,
  'aria-label': ariaLabel,
  children,
}: TableCardProps) {
  const hasHeader = Boolean(title || description || actions)
  return (
    <Card data-slot="table-card" className={cn('mb-4', className)} aria-label={ariaLabel}>
      {hasHeader ? (
        <SectionHeader title={title ?? ''} description={description} actions={actions} />
      ) : null}
      <Table maxHeight={maxHeight} stickyHeader={stickyHeader}>
        {children}
      </Table>
    </Card>
  )
}

export { TableCard }
export type { TableCardProps }
