import type { SortDir } from '../../hooks/useUrlSort'

export interface SortableTableHeaderProps {
  field: string
  label: string
  currentSort: string | null
  currentDir: SortDir | null
  onSort: (field: string, dir: SortDir) => void
}

/**
 * Renders a sticky <th> that cycles asc → desc → unset (clear) on click.
 * Shows ▲ for asc, ▼ for desc, and ⬍ (neutral) when not the active column.
 */
export function SortableTableHeader({
  field,
  label,
  currentSort,
  currentDir,
  onSort,
}: SortableTableHeaderProps) {
  const isActive = currentSort === field

  function handleClick() {
    if (!isActive) {
      // First click on this column → ascending
      onSort(field, 'asc')
    } else if (currentDir === 'asc') {
      // Second click → descending
      onSort(field, 'desc')
    } else {
      // Third click (desc) → clear by calling onSort with 'asc' but on a
      // sentinel that signals "clear". The parent useUrlSort clearSort is
      // exposed via the onSort signature pattern; instead we expose a
      // dedicated clear path by reusing the field with a special convention:
      // pass the empty string to tell the parent to clear.
      onSort('', 'asc')
    }
  }

  const icon = isActive
    ? currentDir === 'asc'
      ? '▲'
      : '▼'
    : '⬍'

  return (
    <th
      onClick={handleClick}
      className="sticky top-0 bg-white z-10 border-b cursor-pointer hover:bg-slate-50 px-4 py-3 text-left text-sm font-medium text-gray-700 whitespace-nowrap select-none"
      aria-sort={
        isActive ? (currentDir === 'asc' ? 'ascending' : 'descending') : 'none'
      }
    >
      <span className="flex items-center gap-1">
        {label}
        <span className="text-xs text-gray-400" aria-hidden="true">
          {icon}
        </span>
      </span>
    </th>
  )
}
