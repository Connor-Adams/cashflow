import { useCallback, useEffect, useState } from 'react'
import { getJson } from '@/lib/api'

/**
 * Receipt completeness hook (#209). Fetches /api/receipts/completeness for a
 * given filter + currency, and re-fetches whenever a `cashflow:receipts-changed`
 * window event fires (dispatched by upload / delete handlers).
 *
 * Returns a small async-state object compatible with the patterns used by
 * `useNetWorth` so the dashboard tile renders consistently with sibling tiles.
 */
export type ReceiptCompletenessFilter = 'all' | 'business' | 'tax-relevant'

export type CompletenessCurrencyBucket = {
  currency: string
  totalCount: number
  withReceiptCount: number
  missingCount: number
  totalAmount: number
  withReceiptAmount: number
  missingAmount: number
  coverageByCount: number
  coverageByAmount: number
}

export type ReceiptCompleteness = CompletenessCurrencyBucket & {
  filter: ReceiptCompletenessFilter
  currency: string | null
  byCurrency: CompletenessCurrencyBucket[]
}

export type MissingReceiptRow = {
  id: number
  date: string
  currency: string
  merchant: string
  category: string | null
  amount: number
  finalBusiness: boolean
}

type AsyncState<T> = { data: T | null; loading: boolean; error: Error | null }

/**
 * Event name dispatched on `window` after a receipt is uploaded or deleted so
 * any subscribed tile/queue refreshes. Lightweight pub-sub — keeps the
 * coverage tile reactive without introducing a new state library.
 */
export const RECEIPTS_CHANGED_EVENT = 'cashflow:receipts-changed'

/** Notify any subscribed components (coverage tile, missing queue, etc.) that
 *  the receipt set has changed. Call this AFTER a successful upload/delete. */
export function notifyReceiptsChanged(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(RECEIPTS_CHANGED_EVENT))
  }
}

function buildPath(
  base: string,
  filter: ReceiptCompletenessFilter,
  currency: string | null,
  extras: Record<string, string | number | undefined> = {},
): string {
  const qs = new URLSearchParams()
  qs.set('filter', filter)
  if (currency) qs.set('currency', currency)
  for (const [k, v] of Object.entries(extras)) {
    if (v == null || v === '') continue
    qs.set(k, String(v))
  }
  return `${base}?${qs.toString()}`
}

function useReceiptsRefetchTrigger(): number {
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    if (typeof window === 'undefined') return
    const handler = () => setNonce((n) => n + 1)
    window.addEventListener(RECEIPTS_CHANGED_EVENT, handler)
    return () => window.removeEventListener(RECEIPTS_CHANGED_EVENT, handler)
  }, [])
  return nonce
}

export function useReceiptCompleteness(
  filter: ReceiptCompletenessFilter = 'all',
  currency: string | null = null,
): AsyncState<ReceiptCompleteness> & { refresh: () => void } {
  const [state, setState] = useState<AsyncState<ReceiptCompleteness>>({
    data: null,
    loading: true,
    error: null,
  })
  const [manualNonce, setManualNonce] = useState(0)
  const eventNonce = useReceiptsRefetchTrigger()

  useEffect(() => {
    let cancelled = false
    setState((s) => ({ ...s, loading: true, error: null }))
    getJson<ReceiptCompleteness>(buildPath('/api/receipts/completeness', filter, currency))
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
  }, [filter, currency, manualNonce, eventNonce])

  const refresh = useCallback(() => setManualNonce((n) => n + 1), [])
  return { ...state, refresh }
}

export function useMissingReceipts(
  filter: ReceiptCompletenessFilter = 'all',
  currency: string | null = null,
  limit?: number,
): AsyncState<{ items: MissingReceiptRow[] }> & { refresh: () => void } {
  const [state, setState] = useState<AsyncState<{ items: MissingReceiptRow[] }>>({
    data: null,
    loading: true,
    error: null,
  })
  const [manualNonce, setManualNonce] = useState(0)
  const eventNonce = useReceiptsRefetchTrigger()

  useEffect(() => {
    let cancelled = false
    setState((s) => ({ ...s, loading: true, error: null }))
    getJson<{ items: MissingReceiptRow[] }>(
      buildPath('/api/receipts/missing', filter, currency, { limit }),
    )
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
  }, [filter, currency, limit, manualNonce, eventNonce])

  const refresh = useCallback(() => setManualNonce((n) => n + 1), [])
  return { ...state, refresh }
}
