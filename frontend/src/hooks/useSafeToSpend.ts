import { useCallback, useEffect, useState } from 'react'
import { getJson, patchJson } from '@/lib/api'
import type {
  CashflowSettings,
  SafeToSpendResponse,
} from '@/types/api'

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

/**
 * Compose the safe-to-spend query path. Currency + asOfDate are optional
 * — the backend picks the household's dominant cash currency and today's
 * date when omitted.
 */
export function buildSafeToSpendPath(opts: {
  currency?: string | null
  asOfDate?: string | null
}): string {
  const params = new URLSearchParams()
  if (opts.currency) params.set('currency', opts.currency)
  if (opts.asOfDate) params.set('asOfDate', opts.asOfDate)
  const q = params.toString()
  return q ? `/api/forecast/safe-to-spend?${q}` : '/api/forecast/safe-to-spend'
}

export function useSafeToSpend(opts: {
  currency?: string | null
  asOfDate?: string | null
  enabled?: boolean
} = {}) {
  const path = opts.enabled === false
    ? null
    : buildSafeToSpendPath({ currency: opts.currency, asOfDate: opts.asOfDate })
  return useFetch<SafeToSpendResponse>(path)
}

export function useCashflowSettings() {
  return useFetch<CashflowSettings>('/api/settings/cashflow')
}

/**
 * Patch the user's cashflow settings. Returns the persisted shape so
 * callers can update local state without a separate refetch.
 */
export async function updateCashflowSettings(
  patch: Partial<CashflowSettings>,
): Promise<CashflowSettings> {
  return patchJson<CashflowSettings>('/api/settings/cashflow', patch)
}
