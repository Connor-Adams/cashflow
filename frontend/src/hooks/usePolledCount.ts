import { useCallback, useEffect, useRef, useState } from 'react'
import { getJson } from '@/lib/api'

const POLL_MS = 5 * 60 * 1000

export type PolledCount = {
  /**
   * Last successfully fetched count, or `null` when no fetch has succeeded
   * yet. A failed fetch never resets this to 0 — a broken endpoint must not
   * read as "nothing pending".
   */
  count: number | null
  loading: boolean
  /** True when the most recent fetch failed. */
  error: boolean
  refetch: () => void
}

/**
 * Polls `path` every 5 minutes and on window focus, deriving a count with
 * `select` (pass a stable, module-level function). Shared by the
 * sidebar/dashboard count badges so they behave consistently — including on
 * failure: keep the last good value, flag `error`, never fabricate a 0.
 */
export function usePolledCount<T>(path: string, select: (body: T) => number): PolledCount {
  const [count, setCount] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const mounted = useRef(true)

  const fetchCount = useCallback(async () => {
    try {
      const body = await getJson<T>(path)
      if (!mounted.current) return
      setCount(select(body))
      setError(false)
    } catch {
      if (mounted.current) setError(true)
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [path, select])

  useEffect(() => {
    mounted.current = true
    void fetchCount()
    const interval = setInterval(() => void fetchCount(), POLL_MS)
    const onFocus = () => void fetchCount()
    window.addEventListener('focus', onFocus)
    return () => {
      mounted.current = false
      clearInterval(interval)
      window.removeEventListener('focus', onFocus)
    }
  }, [fetchCount])

  const refetch = useCallback(() => void fetchCount(), [fetchCount])
  return { count, loading, error, refetch }
}
