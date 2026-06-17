import { useFetch } from './useFetch'
import type { SafeToSpendResponse } from '@/types/api'

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
