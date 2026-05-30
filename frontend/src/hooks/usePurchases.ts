/**
 * React hooks + types for the purchase intelligence feature (issue #218).
 * Mirrors the vanilla useState/useEffect fetch pattern used by the rest of
 * the app (no TanStack Query in this codebase yet). One hook per endpoint
 * plus mutation helpers that return the new payload so the UI can patch
 * state without an extra round-trip.
 */
import { useCallback, useEffect, useState } from 'react'
import { deleteReq, getJson, postJson } from '@/lib/api'

export type PurchaseReceiptStatus = 'unknown' | 'missing' | 'saved'
export type PurchaseWarrantyStatus = 'unknown' | 'none' | 'active' | 'expired'

export const PURCHASE_RECEIPT_STATUSES: ReadonlyArray<PurchaseReceiptStatus> = [
  'unknown',
  'missing',
  'saved',
]

export const PURCHASE_WARRANTY_STATUSES: ReadonlyArray<PurchaseWarrantyStatus> = [
  'unknown',
  'none',
  'active',
  'expired',
]

export type PurchaseFilter = 'all' | 'missing-docs' | 'business' | 'large'

export const PURCHASE_FILTERS: ReadonlyArray<{
  value: PurchaseFilter
  label: string
}> = [
  { value: 'all', label: 'All purchases' },
  { value: 'large', label: 'Large purchases' },
  { value: 'missing-docs', label: 'Missing documentation' },
  { value: 'business', label: 'Business-relevant' },
]

export interface PurchaseTransactionRef {
  id: number
  date: string
  merchant: string
  amount: string
  currency: string
  finalCategory: string | null
  finalBusiness: boolean
  accountName: string | null
}

export interface PurchaseDto {
  transactionId: number
  householdId: number
  markedAt: string
  markedByUserId: number | null
  receiptStatus: PurchaseReceiptStatus
  warrantyStatus: PurchaseWarrantyStatus
  warrantyExpiresAt: string | null
  warrantyProvider: string | null
  businessRelevant: boolean
  usefulLifeMonths: number | null
  notes: string | null
  transaction: PurchaseTransactionRef
  costPerMonth: number
  monthsOwned: number
  hasReceipt: boolean
}

export interface PurchaseListResponse {
  data: PurchaseDto[]
  count: number
  filter: PurchaseFilter
  minAmount: number | null
  currency: string | null
}

export interface LargeInboxRow {
  id: number
  date: string
  merchant: string
  amount: string
  currency: string
  finalCategory: string | null
  finalBusiness: boolean
  accountName: string | null
}

export interface LargeInboxResponse {
  data: LargeInboxRow[]
  count: number
  minAmount: number
  currency: string | null
}

export interface PurchasePatch {
  receiptStatus?: PurchaseReceiptStatus
  warrantyStatus?: PurchaseWarrantyStatus
  warrantyExpiresAt?: string | null
  warrantyProvider?: string | null
  businessRelevant?: boolean
  usefulLifeMonths?: number | null
  notes?: string | null
}

export interface UsePurchasesArgs {
  filter: PurchaseFilter
  minAmount?: number
  currency?: string | null
}

function buildListQuery(args: UsePurchasesArgs): string {
  const params = new URLSearchParams()
  params.set('filter', args.filter)
  if (args.filter === 'large' && args.minAmount && args.minAmount > 0) {
    params.set('minAmount', String(args.minAmount))
  }
  if (args.currency) params.set('currency', args.currency)
  return params.toString()
}

export function usePurchases(args: UsePurchasesArgs) {
  const [data, setData] = useState<PurchaseListResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const d = await getJson<PurchaseListResponse>(
        `/api/purchases?${buildListQuery(args)}`,
      )
      setData(d)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error')
    } finally {
      setLoading(false)
    }
  }, [args.filter, args.minAmount, args.currency]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    void refresh()
  }, [refresh])
  return { data, loading, error, refresh }
}

export interface UseLargeInboxArgs {
  minAmount?: number
  currency?: string | null
}

export function useLargeInbox(args: UseLargeInboxArgs) {
  const [data, setData] = useState<LargeInboxResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      if (args.minAmount && args.minAmount > 0) {
        params.set('minAmount', String(args.minAmount))
      }
      if (args.currency) params.set('currency', args.currency)
      const qs = params.toString()
      const d = await getJson<LargeInboxResponse>(
        `/api/purchases/large-inbox${qs ? `?${qs}` : ''}`,
      )
      setData(d)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error')
    } finally {
      setLoading(false)
    }
  }, [args.minAmount, args.currency])
  useEffect(() => {
    void refresh()
  }, [refresh])
  return { data, loading, error, refresh }
}

export async function upsertPurchase(
  transactionId: number,
  patch: PurchasePatch,
): Promise<PurchaseDto> {
  const resp = await postJson<{ data: PurchaseDto }>(
    `/api/transactions/${transactionId}/purchase`,
    patch,
  )
  return resp.data
}

export async function untrackPurchase(transactionId: number): Promise<void> {
  await deleteReq(`/api/transactions/${transactionId}/purchase`)
}

export async function getPurchase(
  transactionId: number,
): Promise<PurchaseDto | null> {
  try {
    const resp = await getJson<{ data: PurchaseDto }>(
      `/api/transactions/${transactionId}/purchase`,
    )
    return resp.data
  } catch (e) {
    // 404 = not tracked, return null instead of throwing.
    if (e instanceof Error && /404|not found|not tracked/i.test(e.message)) {
      return null
    }
    throw e
  }
}
