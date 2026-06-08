import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useItemsQuery, type ItemsFilters } from '@/hooks/useItems'
import { patchJson } from '@/lib/api'
import { formatMoney } from '../../lib/formatMoney'
import type { ItemRow } from '@cashflow/shared'

type GroupBy = 'purchase' | 'category' | 'none'

type Props = {
  filters: ItemsFilters
  onOpenItem: (id: number, row: ItemRow) => void
  onItemsPatched?: () => void
}

export function ItemsBrowse({ filters, onOpenItem, onItemsPatched }: Props) {
  const { items, nextCursor, loading, error, fetchMore } = useItemsQuery(filters)
  const [groupBy, setGroupBy] = useState<GroupBy>('purchase')
  const [groupMenuOpen, setGroupMenuOpen] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const sentinelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = sentinelRef.current
    if (!el || !nextCursor) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) void fetchMore()
      },
      { rootMargin: '300px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [nextCursor, fetchMore])

  const groups = useMemo(() => groupItems(items, groupBy), [items, groupBy])

  const toggleSelect = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const clearSelection = () => setSelected(new Set())

  const bulkSetCategory = async () => {
    const cat = window.prompt('Category for selected items (blank to clear):')
    if (cat == null) return
    await patchJson('/api/external-order-items/bulk-patch', {
      itemIds: [...selected],
      categoryOverride: cat === '' ? null : cat,
    })
    clearSelection()
    onItemsPatched?.()
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <p className="text-sm text-muted-foreground">
          {items.length} items{nextCursor ? '+' : ''}
        </p>
        <div className="relative">
          <Button size="sm" variant="outline" onClick={() => setGroupMenuOpen((o) => !o)}>
            Group by: {groupBy}
          </Button>
          {groupMenuOpen && (
            <div
              role="menu"
              className="absolute z-10 mt-1 rounded border border-border bg-card text-sm shadow"
            >
              {(['purchase', 'category', 'none'] as GroupBy[]).map((g) => (
                <Button
                  key={g}
                  variant="ghost"
                  role="menuitem"
                  className="block w-full px-3 py-1 text-left hover:bg-muted"
                  onClick={() => {
                    setGroupBy(g)
                    setGroupMenuOpen(false)
                  }}
                >
                  {g}
                </Button>
              ))}
            </div>
          )}
        </div>
      </div>

      {selected.size > 0 && (
        <div
          role="toolbar"
          aria-label="Bulk actions"
          className="sticky top-0 z-10 flex items-center gap-2 rounded border border-border bg-card p-2"
        >
          <span className="text-sm">{selected.size} selected</span>
          <Button size="sm" onClick={() => void bulkSetCategory()}>
            Set category
          </Button>
          <Button size="sm" variant="ghost" onClick={clearSelection}>
            Clear
          </Button>
        </div>
      )}

      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && (
        <p className="text-sm text-destructive">Failed to load items. {error.message}</p>
      )}
      {!loading && !error && items.length === 0 && (
        <p className="text-sm text-muted-foreground">No items match these filters.</p>
      )}

      {groups.map((g) => (
        <section key={g.key}>
          {groupBy !== 'none' && (
            <h3 className="mt-3 mb-1 text-sm font-semibold">
              {g.label}{' '}
              <span className="font-normal text-muted-foreground">
                · {g.rows.length} items
              </span>
            </h3>
          )}
          <ul className="divide-y divide-border">
            {g.rows.map((r) => (
              <li key={r.id} className="flex items-center gap-2 py-1 text-sm">
                <input
                  type="checkbox"
                  aria-label={`Select item ${r.title}`}
                  checked={selected.has(r.id)}
                  onChange={() => toggleSelect(r.id)}
                />
                <Button variant="ghost" className="flex-1 text-left" onClick={() => onOpenItem(r.id, r)}>
                  {r.title}
                </Button>
                <span className="text-muted-foreground">{r.categoryEffective ?? '—'}</span>
                <span className="w-16 text-right">
                  {r.totalPrice != null ? formatMoney(r.totalPrice, r.currency) : '—'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}

      <div ref={sentinelRef} aria-hidden="true" />
    </div>
  )
}

function groupItems(
  rows: ItemRow[],
  by: GroupBy,
): { key: string; label: string; rows: ItemRow[] }[] {
  if (by === 'none') return [{ key: 'all', label: 'All', rows }]
  const buckets = new Map<string, { key: string; label: string; rows: ItemRow[] }>()
  for (const r of rows) {
    const key = by === 'purchase' ? `${r.receipt.id}` : (r.categoryEffective ?? '__none__')
    const label =
      by === 'purchase'
        ? `${r.order.vendor} · ${r.receipt.date ?? '—'}`
        : (r.categoryEffective ?? 'Uncategorized')
    if (!buckets.has(key)) buckets.set(key, { key, label, rows: [] })
    buckets.get(key)!.rows.push(r)
  }
  return [...buckets.values()]
}
