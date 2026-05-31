/**
 * SortableTableHead — a `<th>` that renders a sort indicator and calls
 * onSort when clicked. Pairs with client-side sort state.
 *
 * Usage:
 *   const [sort, setSort] = useState<SortState<'merchant' | 'amount'>>({ field: 'merchant', dir: 'asc' })
 *   <SortableTableHead field="merchant" sort={sort} onSort={setSort}>Merchant</SortableTableHead>
 */
import { ChevronDown, ChevronUp, ChevronsUpDown } from 'lucide-react'
import { cn } from '@/lib/utils'

export type SortDir = 'asc' | 'desc'
export type SortState<F extends string> = { field: F; dir: SortDir }

type Props<F extends string> = {
  field: F
  sort: SortState<F>
  onSort: (next: SortState<F>) => void
  children: React.ReactNode
  className?: string
}

export function SortableTableHead<F extends string>({
  field,
  sort,
  onSort,
  children,
  className,
}: Props<F>) {
  const isActive = sort.field === field
  const nextDir: SortDir = isActive && sort.dir === 'asc' ? 'desc' : 'asc'

  return (
    <th
      data-slot="table-head"
      className={cn(
        'h-10 whitespace-nowrap px-3 text-left align-middle text-xs font-semibold uppercase text-muted-foreground',
        'cursor-pointer select-none hover:text-foreground transition-colors',
        isActive && 'text-foreground',
        className,
      )}
      onClick={() => onSort({ field, dir: nextDir })}
      aria-sort={isActive ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        {isActive ? (
          sort.dir === 'asc' ? (
            <ChevronUp className="h-3 w-3 shrink-0" aria-hidden="true" />
          ) : (
            <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
          )
        ) : (
          <ChevronsUpDown className="h-3 w-3 shrink-0 opacity-40" aria-hidden="true" />
        )}
      </span>
    </th>
  )
}

/** Sort an array of objects by a field. Strings case-insensitive; numbers numeric. */
export function sortBy<T>(items: T[], field: keyof T, dir: SortDir): T[] {
  return [...items].sort((a, b) => {
    const av = a[field]
    const bv = b[field]
    let cmp: number
    if (typeof av === 'number' && typeof bv === 'number') {
      cmp = av - bv
    } else {
      cmp = String(av ?? '').toLowerCase().localeCompare(String(bv ?? '').toLowerCase())
    }
    return dir === 'asc' ? cmp : -cmp
  })
}
