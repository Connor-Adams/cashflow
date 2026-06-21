import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@connor-adams/designsystem'
import { Badge } from '@connor-adams/designsystem'
import { Dialog } from '@connor-adams/designsystem'
import { NativeSelect } from '@connor-adams/designsystem'
import { EmptyState } from '@connor-adams/designsystem'
import { useItemsQuery, type ItemsFilters } from '@/hooks/useItems'
import { hasActiveItemsFilters } from '@/hooks/useItems'
import { patchJson } from '@/lib/api'
import { Link } from 'react-router-dom'
import { formatMoney } from '../../lib/formatMoney'
import type { ItemRow } from '@cashflow/shared'

type GroupBy = 'purchase' | 'category' | 'none'

type Props = {
  filters: ItemsFilters
  onOpenItem: (id: number, row: ItemRow) => void
  onItemsPatched?: () => void
  /** Resets all item filters — wired to the filtered-empty "Clear filters" CTA. */
  onClearFilters?: () => void
}

export function ItemsBrowse({ filters, onOpenItem, onItemsPatched, onClearFilters }: Props) {
  const { items, nextCursor, loading, error, fetchMore } = useItemsQuery(filters)
  const [groupBy, setGroupBy] = useState<GroupBy>('purchase')
  const [groupMenuOpen, setGroupMenuOpen] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [categoryDialogOpen, setCategoryDialogOpen] = useState(false)
  const [pendingCategory, setPendingCategory] = useState('')
  const [bulkSaving, setBulkSaving] = useState(false)
  const [bulkError, setBulkError] = useState<string | null>(null)
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

  // Category hints: the categories already present across the loaded items.
  const categoryOptions = useMemo(() => {
    const set = new Set<string>()
    for (const r of items) if (r.categoryEffective) set.add(r.categoryEffective)
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [items])

  const toggleSelect = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const clearSelection = () => setSelected(new Set())

  const openCategoryDialog = () => {
    setPendingCategory(categoryOptions[0] ?? '')
    setBulkError(null)
    setCategoryDialogOpen(true)
  }

  const applyBulkCategory = async () => {
    setBulkSaving(true)
    setBulkError(null)
    try {
      await patchJson('/api/external-order-items/bulk-patch', {
        itemIds: [...selected],
        categoryOverride: pendingCategory === '' ? null : pendingCategory,
      })
      setCategoryDialogOpen(false)
      clearSelection()
      onItemsPatched?.()
    } catch (e) {
      setBulkError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setBulkSaving(false)
    }
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
          <Button size="sm" onClick={openCategoryDialog}>
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
        hasActiveItemsFilters(filters) ? (
          <EmptyState
            title="Nothing matches this filter"
            description="No items match the current filters. Clear them to see everything."
            actions={
              onClearFilters ? (
                <Button size="sm" variant="outline" onClick={onClearFilters}>
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        ) : (
          <EmptyState
            title="No items yet"
            description="Items appear once you import receipts or orders with line-item detail."
            actions={
              <Link to="/import">
                <Button size="sm">Import a statement</Button>
              </Link>
            }
          />
        )
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
          <ul className="space-y-1">
            {g.rows.map((r) => (
              <li
                key={r.id}
                className="flex items-center gap-3 rounded-md px-2 py-2 transition-colors hover:bg-muted/50"
              >
                <input
                  type="checkbox"
                  aria-label={`Select item ${r.title}`}
                  className="size-4 shrink-0"
                  checked={selected.has(r.id)}
                  onChange={() => toggleSelect(r.id)}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-auto min-w-0 flex-1 justify-start truncate px-1 py-0 text-left text-sm font-normal"
                  onClick={() => onOpenItem(r.id, r)}
                >
                  {r.title}
                </Button>
                {r.receipt.sourceTxnId == null && (
                  <Badge variant="outline" className="text-muted-foreground">
                    Unmatched
                  </Badge>
                )}
                {r.categoryEffective ? (
                  <Badge variant="secondary">{r.categoryEffective}</Badge>
                ) : (
                  <span className="text-xs text-muted-foreground">—</span>
                )}
                <span className="w-16 shrink-0 text-right text-sm tabular-nums">
                  {r.totalPrice != null ? formatMoney(r.totalPrice, r.currency) : '—'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}

      <div ref={sentinelRef} aria-hidden="true" />

      <Dialog
        open={categoryDialogOpen}
        onClose={() => setCategoryDialogOpen(false)}
        title={<>Set category</>}
        description={
          <>Apply a category to {selected.size} selected item{selected.size === 1 ? '' : 's'}.</>
        }
        footer={
          <>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setCategoryDialogOpen(false)}
              disabled={bulkSaving}
            >
              Cancel
            </Button>
            <Button type="button" onClick={() => void applyBulkCategory()} disabled={bulkSaving}>
              {bulkSaving ? 'Saving…' : 'Apply'}
            </Button>
          </>
        }
      >
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Category</span>
          <NativeSelect
            aria-label="Category"
            value={pendingCategory}
            onChange={(e) => setPendingCategory(e.target.value)}
          >
            <option value="">— Clear category (uncategorized)</option>
            {categoryOptions.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </NativeSelect>
        </label>
        {bulkError && (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {bulkError}
          </p>
        )}
      </Dialog>
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
    const unmatched = r.receipt.sourceTxnId == null
    let key: string
    let label: string
    if (by === 'purchase') {
      // Items not reconciled to a transaction collapse into one section rather
      // than scattering under a meaningless "vendor · —" header per order.
      key = unmatched ? '__unmatched__' : `${r.receipt.id}`
      label = unmatched ? 'Unmatched purchases' : `${r.order.vendor} · ${r.receipt.date ?? '—'}`
    } else {
      key = r.categoryEffective ?? '__none__'
      label = r.categoryEffective ?? 'Uncategorized'
    }
    if (!buckets.has(key)) buckets.set(key, { key, label, rows: [] })
    buckets.get(key)!.rows.push(r)
  }
  return [...buckets.values()]
}
