import { patchJson } from '@/lib/api'
import { useFetch } from './useFetch'
import type {
  CreditUtilizationByCurrency,
  NetWorthCurrent,
  NetWorthSeries,
} from '@/types/api'

export function useNetWorthCurrent(asOf?: string) {
  const path = asOf
    ? `/api/net-worth/current?asOf=${asOf}`
    : '/api/net-worth/current'
  return useFetch<NetWorthCurrent>(path)
}

export function useCreditUtilization() {
  return useFetch<CreditUtilizationByCurrency[]>('/api/net-worth/credit-utilization')
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
