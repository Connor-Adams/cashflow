import { useEffect, useRef, useState } from 'react'
import { Button } from '@connor-adams/designsystem'
import { ItemsBrowse } from './ItemsBrowse'
import type { ItemsFilters } from '@/hooks/useItems'
import type { ItemRow } from '@cashflow/shared'

type Props = {
  filters: ItemsFilters
  onChangeFilters: (next: ItemsFilters) => void
  onOpenItem: (id: number, row: ItemRow) => void
}

export function ItemsSearch({ filters, onChangeFilters, onOpenItem }: Props) {
  const [q, setQ] = useState(filters.q ?? '')
  const debounceRef = useRef<number | null>(null)

  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(() => {
      onChangeFilters({ ...filters, q: q || undefined })
    }, 300)
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q])

  const exportUrl = () => {
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries(filters)) {
      if (v == null || v === '') continue
      p.set(k, String(v))
    }
    if (q) p.set('q', q)
    p.set('format', 'csv')
    return `/api/items?${p.toString()}`
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search items"
          className="flex-1 rounded border px-2 py-1 text-sm"
          aria-label="Search items"
        />
        <Button size="sm" onClick={() => window.open(exportUrl(), '_blank')}>
          Export CSV
        </Button>
      </div>
      <ItemsBrowse
        filters={{ ...filters, q: q || undefined }}
        onOpenItem={onOpenItem}
      />
    </div>
  )
}
