import * as React from 'react'
import { Icon } from '@connor-adams/designsystem'
import { cn } from '@/lib/utils'

/**
 * Design-system tree primitives. Shared row chrome for hierarchical lists —
 * the editable category manager and the read-only spend rollup both compose
 * these. Consumers own the data shape and recursion; these own the look:
 * indent guides, the expand/collapse control, grip affordance, icon + action
 * slots, and the brand-tinted highlight (oxblood, matching the house
 * selected-row convention).
 */

/** Root list for a tree. Drag handlers etc. spread onto the <ul>. */
function Tree({ className, ...props }: React.ComponentProps<'ul'>) {
  return <ul className={cn('flex flex-col gap-0.5', className)} {...props} />
}

/** Nested child list — draws the left indent guide. */
function TreeGroup({ className, ...props }: React.ComponentProps<'ul'>) {
  return <ul className={cn('treeGuide ml-[15px] pl-2', className)} {...props} />
}

type TreeRowProps = React.ComponentProps<'div'> & {
  /** Whether this node can expand (has children). */
  expandable?: boolean
  expanded?: boolean
  onToggle?: () => void
  /** Accessible name for the expand/collapse control, e.g. the node's name. */
  toggleLabel?: string
  /** Show the drag-handle affordance (revealed on row hover). */
  grip?: boolean
  /** Drop-target / selected highlight — the hero gradient (sidebar-active treatment). */
  highlighted?: boolean
  /** Leading icon slot (e.g. a category icon, or a button wrapping one). */
  icon?: React.ReactNode
  /** Hover-revealed trailing controls (icon buttons). */
  actions?: React.ReactNode
  /** Always-visible trailing content (e.g. an amount). */
  trailing?: React.ReactNode
  /** The row label — name text, a rename input, etc. */
  children: React.ReactNode
}

function TreeRow({
  expandable, expanded, onToggle, toggleLabel, grip, highlighted,
  icon, actions, trailing, children, className, ...rowProps
}: TreeRowProps) {
  return (
    <div
      className={cn(
        'group flex items-center gap-1.5 rounded-md py-0.5 pr-1 text-sm transition-colors',
        highlighted ? 'treeRowActive' : 'treeRow',
        className,
      )}
      {...rowProps}
    >
      {grip && (
        <Icon
          name="grip-vertical"
          size={14}
          aria-hidden
          className="shrink-0 cursor-grab text-muted-foreground/50 opacity-0 transition-opacity group-hover:opacity-100"
        />
      )}
      {expandable ? (
        <button
          type="button"
          data-slot="tree-toggle"
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${toggleLabel ?? ''}`.trim()}
          aria-expanded={expanded}
          className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted"
          onClick={onToggle}
        >
          {expanded ? <Icon name="chevron-down" size={15} /> : <Icon name="chevron-right" size={15} />}
        </button>
      ) : (
        <span className="inline-block size-5 shrink-0" aria-hidden />
      )}
      {icon != null && <span className="flex shrink-0 items-center">{icon}</span>}
      <div className="flex min-w-0 flex-1 items-center">{children}</div>
      {actions != null && (
        <div className="flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          {actions}
        </div>
      )}
      {trailing != null && <div className="shrink-0">{trailing}</div>}
    </div>
  )
}

export { Tree, TreeGroup, TreeRow }
