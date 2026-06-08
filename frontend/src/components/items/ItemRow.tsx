import { useState, useRef } from 'react'
import { patchJson } from '../../lib/api'
import type { ExternalOrderItemView } from '../../../../shared/api-types'

export type ItemRowProps = {
  item: ExternalOrderItemView
  categoryHints: string[]
  /** Called after a successful PATCH (category or business). Optional. */
  onSaved?: () => void
}

export function ItemRow({ item, categoryHints, onSaved }: ItemRowProps) {
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
    <tr>
      <td>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {item.imageUrl && (
            <a href={item.costcoUrl ?? undefined} target="_blank" rel="noopener noreferrer">
              <img
                src={item.imageUrl}
                alt={item.displayName ?? item.title}
                title={item.imageVerified === false ? 'Best-effort match (unverified)' : undefined}
                width={40}
                height={40}
                style={{ objectFit: 'contain', borderRadius: '4px', border: '1px solid var(--border)', opacity: item.imageVerified === false ? 0.6 : 1 }}
                loading="lazy"
              />
            </a>
          )}
          <div>
            {item.displayName ?? item.title}
            {item.displayName && (
              <div style={{ fontSize: '0.8em', color: 'var(--muted-foreground)' }}>{item.title}</div>
            )}
          </div>
        </div>
      </td>
      <td>{item.quantity}</td>
      <td>{item.totalPrice ?? '—'}</td>
      <td>
        <select
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
        </select>
        {categoryError && <span role="alert">{categoryError}</span>}
      </td>
      <td>
        <input
          type="number"
          min={0}
          max={100}
          value={business}
          onChange={(e) => setBusiness(e.target.value)}
          onBlur={() => void handleBusinessBlur()}
        />
        {businessError && <span role="alert">{businessError}</span>}
      </td>
    </tr>
  )
}
