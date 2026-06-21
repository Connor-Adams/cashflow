import { Icon, TableHead } from '@connor-adams/designsystem'
import type { SortDir } from '@/hooks/useUrlSort'

type Props = {
  field: string
  label: string
  currentSort: string | null
  dir: SortDir
  onSort: (field: string) => void
}

export function SortableTableHead({ field, label, currentSort, dir, onSort }: Props) {
  const active = currentSort === field
  return (
    <TableHead
      className="cursor-pointer select-none hover:bg-accent/30"
      onClick={() => onSort(field)}
      title={`Sort by ${label}`}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active && (dir === 'asc' ? <Icon name="chevron-up" size={14} /> : <Icon name="chevron-down" size={14} />)}
      </span>
    </TableHead>
  )
}
