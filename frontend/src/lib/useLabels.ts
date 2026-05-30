import { useEffect, useState, useCallback } from 'react'
import { getJson } from './api'
import type { Label } from '../types/api'

/**
 * Module-level cache for the household's labels (issue #270), mirroring
 * useCategories: a single in-flight request is shared across mounts, and the
 * resolved list is cached so the chip picker and filter chip don't each refetch.
 * `refresh()` forces a reload (e.g. after creating/renaming/deleting a label).
 */
type Listener = (labels: Label[]) => void

let cache: Label[] | null = null
let inflight: Promise<Label[]> | null = null
const listeners = new Set<Listener>()

export function resetLabelsCache(): void {
  cache = null
  inflight = null
  for (const l of listeners) l([])
  listeners.clear()
}

export const _resetLabelsCacheForTest = resetLabelsCache

async function load(force = false): Promise<Label[]> {
  if (!force && cache) return cache
  if (!force && inflight) return inflight
  inflight = getJson<Label[]>('/api/labels')
    .then((rows) => {
      // Defensive: the endpoint always returns an array, but tests (and a
      // misbehaving response) may yield null/undefined — never let that
      // propagate as the cache, or consumers doing `.length`/`.map` crash.
      const safe = Array.isArray(rows) ? rows : []
      cache = safe
      for (const l of listeners) l(safe)
      return safe
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

export function useLabels(): {
  labels: Label[]
  loading: boolean
  refresh: () => Promise<Label[]>
} {
  const [labels, setLabels] = useState<Label[]>(cache ?? [])
  const [loading, setLoading] = useState<boolean>(cache == null)

  useEffect(() => {
    listeners.add(setLabels)
    setLoading(cache == null)
    load()
      .then((rows) => setLabels(rows))
      .catch(() => {
        /* swallow; refresh() can retry */
      })
      .finally(() => setLoading(false))
    return () => {
      listeners.delete(setLabels)
    }
  }, [])

  const refresh = useCallback(async () => {
    const next = await load(true)
    setLabels(next)
    return next
  }, [])

  return { labels, loading, refresh }
}
