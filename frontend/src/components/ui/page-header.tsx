import * as React from 'react'
import { cn } from '@/lib/utils'

type PageHeaderProps = React.ComponentProps<'section'> & {
  title: string
  description?: React.ReactNode
  actions?: React.ReactNode
}

function PageHeader({
  title,
  description,
  actions,
  className,
  children,
  ...props
}: PageHeaderProps) {
  return (
    <section
      data-slot="page-header"
      className={cn('mb-4 flex flex-wrap items-start justify-between gap-3', className)}
      {...props}
    >
      <div className="min-w-0">
        <h1>{title}</h1>
        {description ? <p className="muted mb-0">{description}</p> : null}
        {children}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
    </section>
  )
}

export { PageHeader }
