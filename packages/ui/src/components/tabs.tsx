/**
 * Minimal controlled-or-uncontrolled tab primitive. Wraps a known list
 * of tab names; consumers render a single body that switches on the
 * active value. Accessibility: role=tablist + role=tab + aria-selected
 * + aria-controls and keyboard arrow navigation across triggers.
 */
import * as React from 'react'
import { cn } from '../lib/cn'

export type TabItem = {
  value: string
  label: React.ReactNode
}

type TabsProps = {
  items: TabItem[]
  value: string
  onValueChange: (v: string) => void
  className?: string
  id?: string
}

export function Tabs({ items, value, onValueChange, className, id }: TabsProps) {
  const autoId = React.useId()
  const baseId = id ?? autoId
  return (
    <div
      role="tablist"
      aria-orientation="horizontal"
      className={cn(
        'inline-flex flex-wrap gap-1 rounded-lg border border-border bg-muted/30 p-1',
        className,
      )}
    >
      {items.map((item) => {
        const isActive = item.value === value
        return (
          <button
            key={item.value}
            id={`${baseId}-tab-${item.value}`}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-controls={`${baseId}-panel-${item.value}`}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onValueChange(item.value)}
            onKeyDown={(event) => {
              const isArrow = event.key === 'ArrowRight' || event.key === 'ArrowLeft'
              const isEdge = event.key === 'Home' || event.key === 'End'
              if (!isArrow && !isEdge) return
              event.preventDefault()
              const idx = items.findIndex((i) => i.value === value)
              let next: TabItem | undefined
              if (event.key === 'Home') next = items[0]
              else if (event.key === 'End') next = items[items.length - 1]
              else if (event.key === 'ArrowRight') next = items[(idx + 1) % items.length]
              else next = items[(idx - 1 + items.length) % items.length]
              if (next) onValueChange(next.value)
            }}
            className={cn(
              'inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-1',
              isActive
                ? 'bg-card text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {item.label}
          </button>
        )
      })}
    </div>
  )
}

type TabPanelProps = {
  value: string
  active: string
  children: React.ReactNode
  className?: string
  tabsId?: string
}

export function TabPanel({ value, active, children, className, tabsId }: TabPanelProps) {
  const baseId = tabsId
  if (value !== active) return null
  return (
    <div
      role="tabpanel"
      id={baseId ? `${baseId}-panel-${value}` : undefined}
      aria-labelledby={baseId ? `${baseId}-tab-${value}` : undefined}
      className={className}
    >
      {children}
    </div>
  )
}
