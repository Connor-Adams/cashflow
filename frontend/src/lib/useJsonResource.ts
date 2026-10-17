import { useEffect, useState } from 'react'
import { getJson } from './api'

/**
 * Load one JSON endpoint into `{ data, loading, error }`, discarding a response
 * that lands after `path` changed or the component unmounted.
 *
 * Tiles and cards that read a single endpoint each carried their own copy of
 * three `useState`s plus this cancellable effect; this is that shape, once.
 *
 * `error` is whatever `getJson` rejected with, not a message — the wording a
 * user sees belongs to the component, which knows what failed to load.
 */
export function useJsonResource<T>(path: string): {
  /** Parsed body; null before the first success, and after a failure. */
  data: T | null
  /** True from the moment `path` changes until that request settles. */
  loading: boolean
  /** The rejection value, or null. */
  error: unknown
} {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    getJson<T>(path)
      .then((json) => {
        if (cancelled) return
        setData(json)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setData(null)
        setError(e)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [path])

  return { data, loading, error }
}
