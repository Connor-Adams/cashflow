import { useState, useRef } from 'react'
import { patchJson } from '../../lib/api'
import { formatMoney } from '../../lib/formatMoney'
import { cn } from '@/lib/utils'
import { TableRow, TableCell } from '@/components/ui/table'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Input } from '@/components/ui/input'
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
  const initialCategory = item.categoryOverride ?? item.inferredCategory ?? ''
  const initialBusiness = item.businessUseOverride ?? item.businessUsePercent ?? ''

  const lastSavedCategoryRef = useRef<string>(initialCategory)
  const lastSavedBusinessRef = useRef<string | number>(initialBusiness)

  const [category, setCategory] = useState<string>(initialCategory)
  const [business, setBusiness] = useState<string | number>(initialBusiness)
  const [categoryError, setCategoryError] = useState<string | null>(null)
  const [businessError, setBusinessError] = useState<string | null>(null)

  async function handleCategoryBlur() {
    if (category === lastSavedCategoryRef.current) return
    setCategoryError(null)
    try {
      await patchJson(`/api/external-order-items/${item.id}`, {
        categoryOverride: category === '' ? null : category,
      })
      lastSavedCategoryRef.current = category
      onSaved?.()
    } catch (e) {
      setCategory(lastSavedCategoryRef.current)
      setCategoryError(e instanceof Error ? e.message : 'Save failed')
    }
  }

  async function handleBusinessBlur() {
    if (business === lastSavedBusinessRef.current) return
    setBusinessError(null)
    const val = business === '' ? null : Number(business)
    try {
      await patchJson(`/api/external-order-items/${item.id}`, {
        businessUseOverride: val,
      })
      lastSavedBusinessRef.current = business
      onSaved?.()
    } catch (e) {
      setBusiness(lastSavedBusinessRef.current)
      setBusinessError(e instanceof Error ? e.message : 'Save failed')
    }
  }

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
