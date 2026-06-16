import { useCallback, useEffect, useState } from 'react'
import { getJson } from '@/lib/api'

export type AsyncState<T> = { data: T | null; loading: boolean; error: Error | null }

/**
 * Path-driven JSON fetch hook shared by the read-only data hooks
 * (useNetWorth, useSafeToSpend, useFxIntelligence, …). Passing `null` for the
 * path leaves the hook idle (no request, `loading: false`) so callers can gate
 * a fetch on props. The same path → same fetch state, so re-renders don't
 * re-fire HTTP; `refresh()` bumps an internal nonce to force a refetch.
 */
export function useFetch<T>(path: string | null): AsyncState<T> & { refresh: () => void } {
  const [state, setState] = useState<AsyncState<T>>({
    data: null,
    loading: path !== null,
    error: null,
  })
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (path === null) return
    let cancelled = false
    setState((s) => ({ ...s, loading: true, error: null }))
    getJson<T>(path)
      .then((data) => {
        if (!cancelled) setState({ data, loading: false, error: null })
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({
            data: null,
            loading: false,
            error: err instanceof Error ? err : new Error(String(err)),
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [path, nonce])

  const refresh = useCallback(() => setNonce((n) => n + 1), [])
  return { ...state, refresh }
}
