import { useCallback, useEffect, useRef, useState } from 'react'
import { getJson } from '@/lib/api'
import type { ItemRow, ItemsListResponse, ItemAllocation } from '@cashflow/shared'

export type ItemsFilters = {
  category?: string
  businessUse?: 'true' | 'false'
  from?: string
  to?: string
  vendor?: string
  minPrice?: number
  maxPrice?: number
  q?: string
}

/**
 * True when any item filter is set. Used to disambiguate an empty result that
 * is "no items at all" (show the import CTA) from "filtered to nothing" (show
 * a clear-filters CTA) — see issue #799.
 */
export function hasActiveItemsFilters(filters: ItemsFilters): boolean {
  return Object.values(filters).some((v) => v != null && v !== '')
}

function buildQuery(filters: ItemsFilters, cursor: string | null): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(filters)) {
    if (v == null || v === '') continue
    p.set(k, String(v))
  }
  if (cursor) p.set('cursor', cursor)
  const s = p.toString()
  return s ? `?${s}` : ''
}

export function useItemsQuery(filters: ItemsFilters) {
  const [items, setItems] = useState<ItemRow[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const filterKey = JSON.stringify(filters)
  const cursorRef = useRef<string | null>(null)
  cursorRef.current = nextCursor
  const filtersRef = useRef(filters)
  filtersRef.current = filters

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const res = await getJson<ItemsListResponse>(`/api/items${buildQuery(filters, null)}`)
        if (cancelled) return
        setItems(res.items)
        setNextCursor(res.nextCursor)
      } catch (e) {
        if (cancelled) return
        setItems([])
        setError(e instanceof Error ? e : new Error(String(e)))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey])

  const fetchMore = useCallback(async () => {
    const cursor = cursorRef.current
    if (!cursor) return
    try {
      const res = await getJson<ItemsListResponse>(
        `/api/items${buildQuery(filtersRef.current, cursor)}`,
      )
      setItems((prev) => [...prev, ...res.items])
      setNextCursor(res.nextCursor)
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)))
    }
  }, [])

  return { items, nextCursor, loading, error, fetchMore }
}

export function useItemAllocation(itemId: number | null) {
  const [data, setData] = useState<ItemAllocation | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    if (itemId == null) {
      setData(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const res = await getJson<ItemAllocation>(`/api/items/${itemId}/allocation`)
        if (!cancelled) setData(res)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e : new Error(String(e)))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [itemId])

  return { data, loading, error }
}
