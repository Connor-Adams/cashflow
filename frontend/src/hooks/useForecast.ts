import { useCallback, useEffect, useState } from 'react'
import { getJson } from '@/lib/api'
import type { ForecastResponse } from '@/types/api'

/**
 * Range presets driven by the issue #198 AC: 7 / 30 / 90 days.
 */
export type ForecastRange = '7d' | '30d' | '90d'

export const FORECAST_RANGE_DAYS: Record<ForecastRange, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
}

export const FORECAST_RANGE_LABEL: Record<ForecastRange, string> = {
  '7d': '7 days',
  '30d': '30 days',
  '90d': '90 days',
}

type AsyncState<T> = { data: T | null; loading: boolean; error: Error | null }

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map((p) => parseInt(p, 10))
  const ms = Date.UTC(y, m - 1, d) + days * 24 * 60 * 60 * 1000
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * Build the query string for /api/forecast. Exposed so consumers can
 * compose the same path for shareable URLs / cache keys.
 */
export function buildForecastQueryString(opts: {
  range: ForecastRange
  currency?: string | null
  accountId?: number | null
  includeRecurring?: boolean
}): string {
  const dateFrom = todayIso()
  const dateTo = addDaysIso(dateFrom, FORECAST_RANGE_DAYS[opts.range])
  const params = new URLSearchParams()
  params.set('dateFrom', dateFrom)
  params.set('dateTo', dateTo)
  if (opts.currency) params.set('currency', opts.currency.toUpperCase().slice(0, 3))
  if (opts.accountId != null) params.set('accountId', String(opts.accountId))
  if (opts.includeRecurring === false) params.set('includeRecurring', 'false')
  return `?${params.toString()}`
}

export type UseForecastOptions = {
  range: ForecastRange
  currency?: string | null
  accountId?: number | null
  includeRecurring?: boolean
}

export function useForecast(
  opts: UseForecastOptions,
): AsyncState<ForecastResponse> & { refresh: () => void } {
  const [state, setState] = useState<AsyncState<ForecastResponse>>({
    data: null,
    loading: true,
    error: null,
  })
  const [nonce, setNonce] = useState(0)

  const qs = buildForecastQueryString(opts)

  useEffect(() => {
    let cancelled = false
    setState((s) => ({ ...s, loading: true, error: null }))
    getJson<ForecastResponse>(`/api/forecast${qs}`)
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
  }, [qs, nonce])

  const refresh = useCallback(() => setNonce((n) => n + 1), [])
  return { ...state, refresh }
}
