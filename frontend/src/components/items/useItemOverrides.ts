import { useRef, useState } from 'react'
import { patchJson } from '../../lib/api'
import type { ExternalOrderItemView } from '../../../../shared/api-types'

/**
 * Shared category / business-use override editing for a single line item.
 * Both the table row (ReviewInboxPage) and the card row (ReceiptItemsDrawer)
 * render different chrome over identical PATCH behavior — keep it in one place.
 *
 * Each field saves on blur (optimistic; reverts + surfaces an error on failure).
 */
export function useItemOverrides(item: ExternalOrderItemView, onSaved?: () => void) {
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

  return {
    category,
    setCategory,
    categoryError,
    handleCategoryBlur,
    business,
    setBusiness,
    businessError,
    handleBusinessBlur,
  }
}
