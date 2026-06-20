import { formatMoney } from '../../lib/formatMoney'
import { cn } from '@/lib/utils'
import { NativeSelect } from '@connor-adams/designsystem'
import { Input } from '@connor-adams/designsystem'
import { useItemOverrides } from './useItemOverrides'
import type { ExternalOrderItemView } from '../../../../shared/api-types'

export type ItemCardProps = {
  item: ExternalOrderItemView
  categoryHints: string[]
  /** ISO 4217 currency code for formatting prices (e.g. "CAD", "USD"). */
  currency?: string
  /** Called after a successful PATCH (category or business). Optional. */
  onSaved?: () => void
}

/**
 * Card presentation of a single line item for the receipt-items slide-over.
 * Shares all PATCH behavior with the table-row variant (ItemRow) via
 * useItemOverrides; only the chrome differs.
 */
export function ItemCard({ item, categoryHints, currency, onSaved }: ItemCardProps) {
  const {
    category,
    setCategory,
    categoryError,
    handleCategoryBlur,
    business,
    setBusiness,
    businessError,
    handleBusinessBlur,
  } = useItemOverrides(item, onSaved)

  return (
    <div className="rounded-md border border-border p-2.5">
      <div className="flex items-center gap-3">
        {item.imageUrl ? (
          <a href={item.costcoUrl ?? undefined} target="_blank" rel="noopener noreferrer" className="shrink-0">
            <img
              src={item.imageUrl}
              alt={item.displayName ?? item.title}
              title={item.imageVerified === false ? 'Best-effort match (unverified)' : undefined}
              width={40}
              height={40}
              className={cn(
                'h-10 w-10 rounded border border-border object-contain',
                item.imageVerified === false && 'opacity-60',
              )}
              loading="lazy"
            />
          </a>
        ) : (
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded border border-border bg-muted text-muted-foreground">
            <span aria-hidden="true" className="text-xs">—</span>
          </div>
        )}

        <div className="min-w-0 flex-1">
          <div className="truncate text-sm">{item.displayName ?? item.title}</div>
          {item.displayName && (
            <div className="truncate text-xs text-muted-foreground">{item.title}</div>
          )}
        </div>

        <div className="shrink-0 text-sm font-medium">
          {item.totalPrice != null ? formatMoney(Number(item.totalPrice), currency) : '—'}
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <NativeSelect
          size="sm"
          aria-label="Category"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          onBlur={() => void handleCategoryBlur()}
        >
          <option value="">(uncategorized)</option>
          {categoryHints.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </NativeSelect>

        <span className="text-xs text-muted-foreground">Qty {item.quantity}</span>

        <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
          Biz %
          <Input
            type="number"
            min={0}
            max={100}
            aria-label="Business use percent"
            className="h-8 w-16"
            value={business}
            onChange={(e) => setBusiness(e.target.value)}
            onBlur={() => void handleBusinessBlur()}
          />
        </label>
      </div>

      {categoryError && (
        <span role="alert" className="mt-1 block text-xs text-danger">
          {categoryError}
        </span>
      )}
      {businessError && (
        <span role="alert" className="mt-1 block text-xs text-danger">
          {businessError}
        </span>
      )}
    </div>
  )
}
