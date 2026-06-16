/**
 * React hooks for the /api/fx/* endpoints (issue #221).
 *
 * Mirrors the pattern in useNetWorth — the shared useFetch helper plus one
 * named hook per endpoint. Path-driven cache keys: the same path → same
 * fetch state, no repeat HTTP on re-renders.
 */
import { useFetch } from './useFetch'
import type {
  CurrencyExposureResponse,
  EffectiveRatesResponse,
  FxFeesResponse,
  FxReportingResponse,
} from '@/types/api'

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
