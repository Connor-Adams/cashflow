import { useCallback } from 'react'
import { Link } from 'react-router-dom'
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
        <p className="emptyState">{emptyLabel}</p>
      ) : (
        <>
          <div className="tableTile">
            <div
              className="tableTile__header"
              style={{ gridTemplateColumns: gridTemplate }}
              role="row"
            >
              {columns.map((c) => (
                <span
                  key={c.key}
                  role="columnheader"
                  className="tableTile__head"
                  data-align={c.align ?? 'left'}
                >
                  {c.label}
                </span>
              ))}
            </div>
            <div className="tableTile__body" role="rowgroup">
              {rows.map((row) => {
                const interactive = Boolean(onRowClick)
                return (
                  <div
                    key={rowKey(row)}
                    role="row"
                    className="tableTile__row"
                    data-interactive={interactive}
                    style={{ gridTemplateColumns: gridTemplate }}
                    tabIndex={interactive ? 0 : undefined}
                    onClick={interactive ? () => onRowClick?.(row) : undefined}
                    onKeyDown={interactive ? (e) => handleKey(e, row) : undefined}
                  >
                    {columns.map((c) => (
                      <span
                        key={c.key}
                        role="cell"
                        className="tableTile__cell"
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
            <div className="tableTile__footer">
              <Link to={viewAllHref} className="tableTile__viewAll">
                {viewAllLabel} →
              </Link>
            </div>
          )}
        </>
      )}
    </BentoTile>
  )
}
