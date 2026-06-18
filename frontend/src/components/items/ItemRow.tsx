import { formatMoney } from '../../lib/formatMoney'
import { cn } from '@/lib/utils'
import { TableRow, TableCell } from '@/components/ui/table'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Input } from '@/components/ui/input'
import { useItemOverrides } from './useItemOverrides'
import type { ExternalOrderItemView } from '../../../../shared/api-types'

export type ItemRowProps = {
  item: ExternalOrderItemView
  categoryHints: string[]
  /** ISO 4217 currency code for formatting prices (e.g. "CAD", "USD"). */
  currency?: string
  /** Called after a successful PATCH (category or business). Optional. */
  onSaved?: () => void
}

export function ItemRow({ item, categoryHints, currency, onSaved }: ItemRowProps) {
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
    <TableRow>
      <TableCell className="whitespace-normal">
        <div className="flex items-center gap-2">
          {item.imageUrl && (
            <a href={item.costcoUrl ?? undefined} target="_blank" rel="noopener noreferrer">
              <img
                src={item.imageUrl}
                alt={item.displayName ?? item.title}
                title={item.imageVerified === false ? 'Best-effort match (unverified)' : undefined}
                width={40}
                height={40}
                className={cn(
                  'rounded border border-border object-contain',
                  item.imageVerified === false && 'opacity-60',
                )}
                loading="lazy"
              />
            </a>
          )}
          <div>
            {item.displayName ?? item.title}
            {item.displayName && (
              <div className="text-xs text-muted-foreground">{item.title}</div>
            )}
          </div>
        </div>
      </TableCell>
      <TableCell>{item.quantity}</TableCell>
      <TableCell>{item.totalPrice != null ? formatMoney(Number(item.totalPrice), currency) : '—'}</TableCell>
      <TableCell>
        <NativeSelect
          size="sm"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          onBlur={() => void handleCategoryBlur()}
        >
          <NativeSelectOption value="">(uncategorized)</NativeSelectOption>
          {categoryHints.map((c) => (
            <NativeSelectOption key={c} value={c}>
              {c}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        {categoryError && (
          <span role="alert" className="mt-1 block text-xs text-danger">
            {categoryError}
          </span>
        )}
      </TableCell>
      <TableCell>
        <Input
          type="number"
          min={0}
          max={100}
          className="h-8 w-20"
          value={business}
          onChange={(e) => setBusiness(e.target.value)}
          onBlur={() => void handleBusinessBlur()}
        />
        {businessError && (
          <span role="alert" className="mt-1 block text-xs text-danger">
            {businessError}
          </span>
        )}
      </TableCell>
    </TableRow>
  )
}
