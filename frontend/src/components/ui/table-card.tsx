import * as React from 'react'
import { ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Card } from '@connor-adams/designsystem'
import { SectionHeader } from './section-header'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@connor-adams/designsystem'
import { EmptyTableRow } from '@/lib/ds-extras'

type SortDir = 'asc' | 'desc'
type TableSort = { key: string; dir: SortDir }

type TableColumn<T> = {
  /** unique id; default sort/render accessor reads (row as any)[key] */
  key: string
  header: React.ReactNode
  sortable?: boolean
  /** value used for sorting; default (row as any)[key] */
  accessor?: (row: T) => string | number | null | undefined
  /** cell content; default String(accessor value ?? '') */
  render?: (row: T, index: number) => React.ReactNode
  /** th + td text alignment; default 'left' */
  align?: 'left' | 'right' | 'center'
  /** applied to each td */
  className?: string
  /** applied to the th */
  headClassName?: string
  /** optional fixed width (inline style on th) */
  width?: string
}

type TableCardBaseProps = {
  title?: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  maxHeight?: string
  className?: string
  'aria-label'?: string
}

type TableCardChildrenProps = TableCardBaseProps & {
  children: React.ReactNode
  columns?: never
  rows?: never
}

type TableCardDataProps<T> = TableCardBaseProps & {
  columns: TableColumn<T>[]
  rows: T[]
  defaultSort?: TableSort
  getRowKey?: (row: T, index: number) => React.Key
  onRowClick?: (row: T, index: number) => void
  empty?: React.ReactNode
  children?: never
}

type TableCardProps<T> = TableCardChildrenProps | TableCardDataProps<T>

const alignClass = {
  left: 'text-left',
  right: 'text-right',
  center: 'text-center',
} as const

function getAccessorValue<T>(column: TableColumn<T>, row: T) {
  if (column.accessor) return column.accessor(row)
  return (row as Record<string, unknown>)[column.key] as
    | string
    | number
    | null
    | undefined
}

function compareValues(
  a: string | number | null | undefined,
  b: string | number | null | undefined,
  dir: SortDir
): number {
  const aNil = a === null || a === undefined
  const bNil = b === null || b === undefined
  // null/undefined sort last regardless of dir
  if (aNil && bNil) return 0
  if (aNil) return 1
  if (bNil) return -1

  let result: number
  if (typeof a === 'number' && typeof b === 'number') {
    result = a - b
  } else {
    result = String(a).localeCompare(String(b))
  }
  return dir === 'asc' ? result : -result
}

function isDataMode<T>(props: TableCardProps<T>): props is TableCardDataProps<T> {
  return 'columns' in props && props.columns !== undefined
}

function TableCard<T,>(props: TableCardProps<T>) {
  const {
    title,
    description,
    actions,
    maxHeight = '72vh',
    className,
    'aria-label': ariaLabel,
  } = props

  const hasHeader = Boolean(title || description || actions)

  return (
    <Card data-slot="table-card" className={cn('mb-4', className)} aria-label={ariaLabel}>
      {hasHeader ? (
        <SectionHeader title={title ?? ''} description={description} actions={actions} />
      ) : null}
      <Table maxHeight={maxHeight}>
        {isDataMode(props) ? <TableCardData {...props} /> : props.children}
      </Table>
    </Card>
  )
}

function TableCardData<T>({
  columns,
  rows,
  defaultSort,
  getRowKey,
  onRowClick,
  empty,
}: TableCardDataProps<T>) {
  const [sort, setSort] = React.useState<TableSort | null>(defaultSort ?? null)

  const sortedRows = React.useMemo(() => {
    if (!sort) return rows
    const column = columns.find((c) => c.key === sort.key)
    if (!column) return rows
    // stable sort: decorate with index, sort, undecorate
    return rows
      .map((row, index) => ({ row, index }))
      .sort((a, b) => {
        const cmp = compareValues(
          getAccessorValue(column, a.row),
          getAccessorValue(column, b.row),
          sort.dir
        )
        return cmp !== 0 ? cmp : a.index - b.index
      })
      .map((d) => d.row)
  }, [rows, columns, sort])

  const handleSort = React.useCallback(
    (key: string) => {
      setSort((current) => {
        if (!current || current.key !== key) {
          return { key, dir: 'asc' }
        }
        if (current.dir === 'asc') {
          return { key, dir: 'desc' }
        }
        // current.dir === 'desc' -> revert to default (or null)
        return defaultSort ?? null
      })
    },
    [defaultSort]
  )

  return (
    <>
      <TableHeader>
        <TableRow>
          {columns.map((column) => {
            const align = column.align ?? 'left'
            const isSorted = sort?.key === column.key
            const ariaSort = column.sortable
              ? isSorted
                ? sort?.dir === 'asc'
                  ? 'ascending'
                  : 'descending'
                : 'none'
              : undefined
            return (
              <TableHead
                key={column.key}
                className={cn(alignClass[align], column.headClassName)}
                style={column.width ? { width: column.width } : undefined}
                aria-sort={ariaSort}
              >
                {column.sortable ? (
                  <button
                    type="button"
                    onClick={() => handleSort(column.key)}
                    className={cn(
                      'inline-flex w-full items-center gap-1 border-0 bg-transparent p-0 font-semibold uppercase text-inherit hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                      align === 'right' && 'justify-end',
                      align === 'center' && 'justify-center'
                    )}
                  >
                    <span>{column.header}</span>
                    {isSorted ? (
                      sort?.dir === 'asc' ? (
                        <ChevronUp aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                      ) : (
                        <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                      )
                    ) : (
                      <ChevronsUpDown
                        aria-hidden="true"
                        className="h-3.5 w-3.5 shrink-0 opacity-40"
                      />
                    )}
                  </button>
                ) : (
                  column.header
                )}
              </TableHead>
            )
          })}
        </TableRow>
      </TableHeader>
      <TableBody>
        {sortedRows.length === 0 ? (
          empty != null ? (
            <EmptyTableRow colSpan={columns.length} title={empty} />
          ) : (
            <TableRow>
              <TableCell colSpan={columns.length} className="text-muted-foreground">
                No data
              </TableCell>
            </TableRow>
          )
        ) : (
          sortedRows.map((row, index) => (
            <TableRow
              key={getRowKey ? getRowKey(row, index) : index}
              onClick={onRowClick ? () => onRowClick(row, index) : undefined}
              className={onRowClick ? 'cursor-pointer' : undefined}
            >
              {columns.map((column) => {
                const align = column.align ?? 'left'
                const content = column.render
                  ? column.render(row, index)
                  : String(getAccessorValue(column, row) ?? '')
                return (
                  <TableCell
                    key={column.key}
                    className={cn(alignClass[align], column.className)}
                  >
                    {content}
                  </TableCell>
                )
              })}
            </TableRow>
          ))
        )}
      </TableBody>
    </>
  )
}

export { TableCard }
// SortDir is intentionally NOT exported: the canonical SortDir lives in
// hooks/useUrlSort. Re-exporting it here is a duplicate export (fallow
// duplicate-exports). TableSort carries the direction; consumers needing the
// bare union import it from useUrlSort.
export type { TableCardProps, TableColumn, TableSort }
