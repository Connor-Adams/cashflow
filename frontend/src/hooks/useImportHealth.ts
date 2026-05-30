import { useCallback, useEffect, useState } from 'react'
import { getJson } from '@/lib/api'
import type { ImportHealthResponse } from '@cashflow/shared'

/**
 * Import-health hook (#214). Fetches /api/import/health for the supplied
 * currency, with a minimal async-state shape compatible with the dashboard's
 * sibling hooks (useReceiptCompleteness etc.). No background polling — the
 * tile is recomputed on each navigation and after an import-committed event
 * via the existing `historyRefreshKey` plumbing.
 */

type AsyncState<T> = { data: T | null; loading: boolean; error: Error | null }

function buildPath(currency: string | null): string {
  if (!currency) return '/api/import/health'
  const qs = new URLSearchParams({ currency })
  return `/api/import/health?${qs.toString()}`
}

export function useImportHealth(currency: string | null): AsyncState<ImportHealthResponse> & {
  refresh: () => void
} {
  const [state, setState] = useState<AsyncState<ImportHealthResponse>>({
    data: null,
    loading: true,
    error: null,
  })
  const [nonce, setNonce] = useState(0)

  const refresh = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    let cancelled = false
    setState((prev) => ({ ...prev, loading: true, error: null }))
    void getJson<ImportHealthResponse>(buildPath(currency))
      .then((data) => {
        if (cancelled) return
        setState({ data, loading: false, error: null })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setState({
          data: null,
          loading: false,
          error: err instanceof Error ? err : new Error(String(err)),
        })
      })
    return () => {
      cancelled = true
    }
  }, [currency, nonce])

  return { ...state, refresh }
}
