import * as React from 'react'
import { cn } from '@/lib/utils'

type SectionHeaderProps = Omit<React.ComponentProps<'div'>, 'title'> & {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
}

function SectionHeader({ title, description, actions, className, children, ...props }: SectionHeaderProps) {
  return (
    <div
      data-slot="section-header"
      className={cn('mb-4 flex flex-wrap items-start justify-between gap-3', className)}
      {...props}
    >
      <div className="min-w-0">
        <h2 className="mb-1 mt-0 text-[1.05rem] font-semibold tracking-tight">{title}</h2>
        {description ? (
          <p className="mb-0 text-sm leading-6 text-muted-foreground">{description}</p>
        ) : null}
        {children}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
    </div>
  )
}

export { SectionHeader }
export type { SectionHeaderProps }
