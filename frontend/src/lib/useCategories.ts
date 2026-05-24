import { useEffect, useState, useCallback } from 'react'
import { getJson } from './api'
import type { Category } from '../types/api'

type Listener = (cats: Category[]) => void

let cache: Category[] | null = null
let inflight: Promise<Category[]> | null = null
const listeners = new Set<Listener>()

export function _resetCategoriesCacheForTest(): void {
  cache = null
  inflight = null
  listeners.clear()
}

async function load(force = false): Promise<Category[]> {
  if (!force && cache) return cache
  if (!force && inflight) return inflight
  inflight = getJson<Category[]>('/api/categories')
    .then((rows) => {
      cache = rows
      for (const l of listeners) l(rows)
      return rows
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

export function useCategories(): {
  categories: Category[]
  refresh: () => Promise<void>
  byName: (name: string | null | undefined) => Category | undefined
} {
  const [categories, setCategories] = useState<Category[]>(cache ?? [])

  useEffect(() => {
    listeners.add(setCategories)
    load().then(setCategories).catch(() => {/* swallow; refresh() can retry */})
    return () => { listeners.delete(setCategories) }
  }, [])

  const refresh = useCallback(async () => {
    const next = await load(true)
    setCategories(next)
  }, [])

  const byName = useCallback(
    (name: string | null | undefined) =>
      name ? categories.find((c) => c.name === name) : undefined,
    [categories]
  )

  return { categories, refresh, byName }
}
