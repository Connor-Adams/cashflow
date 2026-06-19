import { useState, type ReactNode } from 'react'
import { Button } from '@cashflow/ui'
import type { ItemsFilters } from '@/hooks/useItems'

type Props = {
  filters: ItemsFilters
  onChange: (next: ItemsFilters) => void
}

type ChipName = 'category' | 'businessUse' | 'date' | 'vendor' | 'price'

export function ItemsFilterStrip({ filters, onChange }: Props) {
  const [openChip, setOpenChip] = useState<ChipName | null>(null)

  const close = () => setOpenChip(null)
  const apply = (patch: Partial<ItemsFilters>) => {
    onChange({ ...filters, ...patch })
    close()
  }
  const clear = (k: keyof ItemsFilters) => {
    const next = { ...filters }
    delete next[k]
    onChange(next)
  }

  const [categoryDraft, setCategoryDraft] = useState(filters.category ?? '')
  const [vendorDraft, setVendorDraft] = useState(filters.vendor ?? '')
  const [fromDraft, setFromDraft] = useState(filters.from ?? '')
  const [toDraft, setToDraft] = useState(filters.to ?? '')
  const [minDraft, setMinDraft] = useState<string>(filters.minPrice != null ? String(filters.minPrice) : '')
  const [maxDraft, setMaxDraft] = useState<string>(filters.maxPrice != null ? String(filters.maxPrice) : '')

  return (
    <div className="flex flex-wrap gap-2" role="toolbar" aria-label="Item filters">
      <Chip
        label={filters.category ? `Category: ${filters.category}` : 'Category'}
        active={!!filters.category}
        open={openChip === 'category'}
        onOpen={() => setOpenChip('category')}
        onClose={close}
        onClear={() => clear('category')}
      >
        <input
          autoFocus
          value={categoryDraft}
          onChange={(e) => setCategoryDraft(e.target.value)}
          placeholder="Category name"
          className="rounded border px-2 py-1 text-sm"
          onKeyDown={(e) => {
            if (e.key === 'Enter') apply({ category: categoryDraft || undefined })
            if (e.key === 'Escape') close()
          }}
        />
        <Button size="sm" onClick={() => apply({ category: categoryDraft || undefined })}>
          Apply
        </Button>
      </Chip>

      <Chip
        label={filters.businessUse ? `Business use: ${filters.businessUse}` : 'Business use'}
        active={!!filters.businessUse}
        open={openChip === 'businessUse'}
        onOpen={() => setOpenChip('businessUse')}
        onClose={close}
        onClear={() => clear('businessUse')}
      >
        <Button size="sm" variant="outline" onClick={() => apply({ businessUse: 'true' })}>
          Yes
        </Button>
        <Button size="sm" variant="outline" onClick={() => apply({ businessUse: 'false' })}>
          No
        </Button>
      </Chip>

      <Chip
        label={
          filters.from || filters.to
            ? `Date: ${filters.from ?? '…'} → ${filters.to ?? '…'}`
            : 'Date'
        }
        active={!!(filters.from || filters.to)}
        open={openChip === 'date'}
        onOpen={() => setOpenChip('date')}
        onClose={close}
        onClear={() => onChange({ ...filters, from: undefined, to: undefined })}
      >
        <input
          type="date"
          value={fromDraft}
          onChange={(e) => setFromDraft(e.target.value)}
          className="rounded border px-2 py-1 text-sm"
        />
        <input
          type="date"
          value={toDraft}
          onChange={(e) => setToDraft(e.target.value)}
          className="rounded border px-2 py-1 text-sm"
        />
        <Button
          size="sm"
          onClick={() => apply({ from: fromDraft || undefined, to: toDraft || undefined })}
        >
          Apply
        </Button>
      </Chip>

      <Chip
        label={filters.vendor ? `Vendor: ${filters.vendor}` : 'Vendor'}
        active={!!filters.vendor}
        open={openChip === 'vendor'}
        onOpen={() => setOpenChip('vendor')}
        onClose={close}
        onClear={() => clear('vendor')}
      >
        <input
          autoFocus
          value={vendorDraft}
          onChange={(e) => setVendorDraft(e.target.value)}
          placeholder="Vendor name"
          className="rounded border px-2 py-1 text-sm"
          onKeyDown={(e) => {
            if (e.key === 'Enter') apply({ vendor: vendorDraft || undefined })
            if (e.key === 'Escape') close()
          }}
        />
        <Button size="sm" onClick={() => apply({ vendor: vendorDraft || undefined })}>
          Apply
        </Button>
      </Chip>

      <Chip
        label={
          filters.minPrice != null || filters.maxPrice != null
            ? `Price: $${filters.minPrice ?? 0}–$${filters.maxPrice ?? '∞'}`
            : 'Price'
        }
        active={!!(filters.minPrice != null || filters.maxPrice != null)}
        open={openChip === 'price'}
        onOpen={() => setOpenChip('price')}
        onClose={close}
        onClear={() => onChange({ ...filters, minPrice: undefined, maxPrice: undefined })}
      >
        <input
          type="number"
          value={minDraft}
          onChange={(e) => setMinDraft(e.target.value)}
          placeholder="min"
          className="w-20 rounded border px-2 py-1 text-sm"
        />
        <input
          type="number"
          value={maxDraft}
          onChange={(e) => setMaxDraft(e.target.value)}
          placeholder="max"
          className="w-20 rounded border px-2 py-1 text-sm"
        />
        <Button
          size="sm"
          onClick={() =>
            apply({
              minPrice: minDraft ? Number(minDraft) : undefined,
              maxPrice: maxDraft ? Number(maxDraft) : undefined,
            })
          }
        >
          Apply
        </Button>
      </Chip>
    </div>
  )
}

function Chip({
  label,
  active,
  open,
  onOpen,
  onClose,
  onClear,
  children,
}: {
  label: string
  active: boolean
  open: boolean
  onOpen: () => void
  onClose: () => void
  onClear: () => void
  children: ReactNode
}) {
  return (
    <div className="relative">
      <Button
        type="button"
        variant={active ? 'outline' : 'ghost'}
        size="sm"
        aria-expanded={open}
        aria-label={label}
        onClick={(e) => {
          if (e.metaKey && active) {
            onClear()
            return
          }
          if (open) onClose()
          else onOpen()
        }}
        className="rounded-full"
      >
        {label}
      </Button>
      {open && (
        <div className="absolute z-10 mt-1 flex gap-2 rounded border border-border bg-card p-2 shadow">
          {children}
        </div>
      )}
    </div>
  )
}
