import { useCallback, useEffect, useState } from 'react'
import { getJson, patchJson } from '@/lib/api'
import type { NetWorthCurrent, NetWorthSeries } from '@/types/api'

type AsyncState<T> = { data: T | null; loading: boolean; error: Error | null }

function useFetch<T>(path: string | null): AsyncState<T> & { refresh: () => void } {
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

export function useNetWorthCurrent(asOf?: string) {
  const path = asOf
    ? `/api/net-worth/current?asOf=${asOf}`
    : '/api/net-worth/current'
  return useFetch<NetWorthCurrent>(path)
}

export function useNetWorthSeries(
  params: { from: string; to: string; granularity: 'monthly' | 'daily' } | null,
) {
  const path = params
    ? `/api/net-worth/series?from=${params.from}&to=${params.to}&granularity=${params.granularity}`
    : null
  return useFetch<NetWorthSeries>(path)
}

export async function updateOpeningBalance(
  accountId: number,
  body: { openingBalance: number; openingBalanceDate: string | null },
): Promise<void> {
  await patchJson(`/api/net-worth/accounts/${accountId}/opening-balance`, body)
}
