import { ChevronDown, ChevronUp } from 'lucide-react'
import { TableHead } from '@/components/ui/table'
import type { SortDir } from '@/hooks/useUrlSort'

type Props = {
  field: string
  currentSort: string | null
  dir: SortDir
  onSort: (field: string) => void
  children: React.ReactNode
  className?: string
}

export function SortableTableHead({
  field,
  currentSort,
  dir,
  onSort,
  children,
  className,
}: Props) {
  const isActive = currentSort === field
  return (
    <TableHead className={`sticky top-0 bg-background z-10 ${className ?? ''}`}>
      <button
        type="button"
        onClick={() => onSort(field)}
        className="inline-flex items-center gap-1 cursor-pointer hover:text-foreground text-inherit w-full text-left"
        title={`Sort by ${String(children)}`}
      >
        <span>{children}</span>
        {isActive ? (
          dir === 'asc' ? (
            <ChevronUp size={14} aria-label="sorted ascending" />
          ) : (
            <ChevronDown size={14} aria-label="sorted descending" />
          )
        ) : null}
      </button>
    </TableHead>
  )
}
