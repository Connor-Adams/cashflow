import * as React from 'react'
import { Icon } from '@connor-adams/designsystem'
import { cn } from '@/lib/utils'

export type CollapsibleCardProps = {
  id?: string
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  defaultOpen?: boolean
  className?: string
  /** Accessible label for the chevron toggle. Falls back to `title` when it's a string. */
  toggleLabel?: string
  children: React.ReactNode
}

export function CollapsibleCard({
  id,
  title,
  description,
  actions,
  defaultOpen = true,
  className,
  toggleLabel,
  children,
}: CollapsibleCardProps) {
  const [open, setOpen] = React.useState(defaultOpen)
  const reactId = React.useId()
  const bodyId = `collapsible-card-${reactId}`
  const chevron = open ? 'chevron-down' : 'chevron-right'
  const label =
    toggleLabel ?? (typeof title === 'string' ? title : 'section')

  const toggle = React.useCallback(() => setOpen((v) => !v), [])

  return (
    <section
      id={id}
      data-slot="collapsible-card"
      data-state={open ? 'open' : 'closed'}
      className={cn('card mb-4', className)}
    >
      <div
        className="reportsCardHeader cursor-pointer"
        onClick={(e) => {
          const target = e.target as HTMLElement
          if (
            target.closest('[data-slot="collapsible-card-actions"]') ||
            target.closest('[data-slot="collapsible-card-toggle"]')
          ) {
            return
          }
          toggle()
        }}
      >
        <div className="min-w-0 flex-1">
          <h2 className="m-0">{title}</h2>
          {description && <p className="muted m-0 mt-1">{description}</p>}
        </div>
        {actions && (
          <div
            data-slot="collapsible-card-actions"
            className="flex shrink-0 items-center gap-2"
          >
            {actions}
          </div>
        )}
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls={bodyId}
          aria-label={open ? `Collapse ${label}` : `Expand ${label}`}
          data-slot="collapsible-card-toggle"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border-0 bg-transparent text-muted-foreground hover:bg-[color-mix(in_srgb,var(--bg3)_50%,transparent)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Icon name={chevron} aria-hidden="true" className="h-4 w-4" />
        </button>
      </div>
      {open && (
        <div
          id={bodyId}
          data-slot="collapsible-card-body"
          className="mt-4"
        >
          {children}
        </div>
      )}
    </section>
  )
}
