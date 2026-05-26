/**
 * React hooks for the /api/fx/* endpoints (issue #221).
 *
 * Mirrors the pattern in useNetWorth — a shared useFetch helper plus one
 * named hook per endpoint. Path-driven cache keys: the same path → same
 * fetch state, no repeat HTTP on re-renders.
 */
import { useCallback, useEffect, useState } from 'react'
import { getJson } from '@/lib/api'
import type {
  CurrencyExposureResponse,
  EffectiveRatesResponse,
  FxFeesResponse,
  FxReportingResponse,
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

export interface FxFiltersParams {
  dateFrom?: string
  dateTo?: string
  reportingCurrency?: string
}

function buildQuery(params: FxFiltersParams): string {
  const usp = new URLSearchParams()
  if (params.dateFrom) usp.set('dateFrom', params.dateFrom)
  if (params.dateTo) usp.set('dateTo', params.dateTo)
  if (params.reportingCurrency) usp.set('reportingCurrency', params.reportingCurrency)
  const qs = usp.toString()
  return qs ? `?${qs}` : ''
}

export function useCurrencyExposure(params: FxFiltersParams) {
  return useFetch<CurrencyExposureResponse>(`/api/fx/exposure${buildQuery(params)}`)
}

export function useFxFees(params: FxFiltersParams & { limit?: number }) {
  const usp = new URLSearchParams()
  if (params.dateFrom) usp.set('dateFrom', params.dateFrom)
  if (params.dateTo) usp.set('dateTo', params.dateTo)
  if (params.limit) usp.set('limit', String(params.limit))
  const qs = usp.toString()
  return useFetch<FxFeesResponse>(`/api/fx/fees${qs ? `?${qs}` : ''}`)
}

export function useEffectiveRates(params: FxFiltersParams & { limit?: number }) {
  const usp = new URLSearchParams()
  if (params.dateFrom) usp.set('dateFrom', params.dateFrom)
  if (params.dateTo) usp.set('dateTo', params.dateTo)
  if (params.limit) usp.set('limit', String(params.limit))
  const qs = usp.toString()
  return useFetch<EffectiveRatesResponse>(`/api/fx/effective-rates${qs ? `?${qs}` : ''}`)
}

export function useFxReporting(params: FxFiltersParams) {
  return useFetch<FxReportingResponse>(`/api/fx/reporting${buildQuery(params)}`)
}
