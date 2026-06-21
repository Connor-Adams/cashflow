import { useCallback } from 'react'
import { Link } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { BentoTile, type BentoSpan } from './BentoTile'

export type TableTileColumn<R> = {
  /** Stable identifier used as the React key for the header cell. */
  key: string
  label: string
  align?: 'left' | 'right'
  /** Optional explicit width hint (e.g. '4rem'). When set, the column
   *  becomes a fixed-width grid track; remaining columns share `1fr`. */
  width?: string
  render: (row: R) => React.ReactNode
}

type TableTileProps<R> = {
  /** Bento span. 6 for paired tiles, 12 for a wide finale. */
  span: BentoSpan
  label: string
  description?: string
  columns: TableTileColumn<R>[]
  rows: R[]
  rowKey: (row: R) => string
  /** Optional row click handler. When set, rows are keyboard-focusable
   *  and trigger on Enter / Space. */
  onRowClick?: (row: R) => void
  /** Footer "view all" link — rendered when present. */
  viewAllLabel?: string
  viewAllHref?: string
  /** Shown when rows is empty and not loading. */
  emptyLabel: string
  loading?: boolean
}

/**
 * Compact top-N table living inside a BentoTile. Designed to fit 5-6
 * rows comfortably in a 2-row tile alongside a header + optional footer
 * "view all" link. Uses CSS Grid (.tableTile__row) rather than a real
 * `<table>` so column alignment is controlled per-tile via the columns
 * spec and rows can be clickable elements with proper a11y semantics.
 */
export function TableTile<R>({
  span,
  label,
  description,
  columns,
  rows,
  rowKey,
  onRowClick,
  viewAllLabel,
  viewAllHref,
  emptyLabel,
  loading,
}: TableTileProps<R>) {
  const gridTemplate = columns
    .map((c) => c.width ?? '1fr')
    .join(' ')

  const handleKey = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>, row: R) => {
      if (!onRowClick) return
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onRowClick(row)
      }
    },
    [onRowClick]
  )

  return (
    <BentoTile
      span={span}
      rows={2}
      aria-busy={loading}
      label={label}
      description={description}
    >
      {rows.length === 0 ? (
        <p className="m-0 text-muted-foreground">{emptyLabel}</p>
      ) : (
        <>
          {/* formerly .tableTile */}
          <div className="flex min-h-0 flex-1 flex-col">
            {/* formerly .tableTile__header */}
            <div
              className="grid items-center gap-2 py-1 border-b border-border"
              style={{ gridTemplateColumns: gridTemplate }}
              role="row"
            >
              {columns.map((c) => (
                // formerly .tableTile__head + [data-align="right"]
                <span
                  key={c.key}
                  role="columnheader"
                  className="truncate text-[0.7rem] font-bold uppercase tracking-wide text-muted-foreground"
                  style={c.align === 'right' ? { textAlign: 'right', fontVariantNumeric: 'tabular-nums' } : undefined}
                  data-align={c.align ?? 'left'}
                >
                  {c.label}
                </span>
              ))}
            </div>
            {/* formerly .tableTile__body */}
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" role="rowgroup">
              {rows.map((row) => {
                const interactive = Boolean(onRowClick)
                return (
                  // formerly .tableTile__row + sibling border + interactive states
                  <div
                    key={rowKey(row)}
                    role="row"
                    className={cn(
                      'grid items-center gap-2 py-1',
                      '[&+&]:border-t [&+&]:border-[color-mix(in_oklch,var(--border)_60%,transparent)]',
                      interactive && [
                        'cursor-pointer rounded-[6px] mx-[-4px] px-[4px]',
                        'transition-colors duration-[150ms]',
                        'hover:bg-[color-mix(in_oklch,var(--muted)_50%,transparent)]',
                        'focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2',
                      ],
                    )}
                    data-interactive={interactive}
                    style={{ gridTemplateColumns: gridTemplate }}
                    tabIndex={interactive ? 0 : undefined}
                    onClick={interactive ? () => onRowClick?.(row) : undefined}
                    onKeyDown={interactive ? (e) => handleKey(e, row) : undefined}
                  >
                    {columns.map((c) => (
                      // formerly .tableTile__cell + [data-align="right"]
                      <span
                        key={c.key}
                        role="cell"
                        className="truncate text-sm text-foreground"
                        style={c.align === 'right' ? { textAlign: 'right', fontVariantNumeric: 'tabular-nums' } : undefined}
                        data-align={c.align ?? 'left'}
                      >
                        {c.render(row)}
                      </span>
                    ))}
                  </div>
                )
              })}
            </div>
          </div>
          {viewAllLabel && viewAllHref && (
            // formerly .tableTile__footer
            <div className="mt-2 flex justify-end pt-2 border-t border-border">
              {/* formerly .tableTile__viewAll + :hover */}
              <Link to={viewAllHref} className="text-xs font-semibold no-underline text-primary hover:underline">
                {viewAllLabel} →
              </Link>
            </div>
          )}
        </>
      )}
    </BentoTile>
  )
}
