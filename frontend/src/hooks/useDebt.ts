import { useCallback, useEffect, useState } from 'react'
import { getJson, postJson, putJson } from '@/lib/api'
import type {
  DebtOverview,
  DebtLiabilityProfile,
  DebtPayoffStrategy,
  DebtScenarioResponse,
} from '@/types/api'

type AsyncState<T> = { data: T | null; loading: boolean; error: Error | null }

/**
 * Load the debt overview — liabilities + their profiles + a default
 * avalanche-vs-snowball comparison for the supplied extra monthly payment.
 * Mirrors useForecast: returns {data, loading, error, refresh}.
 */
export function useDebt(
  extraMonthlyPayment: number,
): AsyncState<DebtOverview> & { refresh: () => void } {
  const [state, setState] = useState<AsyncState<DebtOverview>>({
    data: null,
    loading: true,
    error: null,
  })
  const [nonce, setNonce] = useState(0)

  const params = new URLSearchParams()
  if (extraMonthlyPayment > 0) {
    params.set('extraMonthlyPayment', String(extraMonthlyPayment))
  }
  const qs = params.toString() ? `?${params.toString()}` : ''

  useEffect(() => {
    let cancelled = false
    setState((s) => ({ ...s, loading: true, error: null }))
    getJson<DebtOverview>(`/api/debt${qs}`)
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

/** Upsert a liability profile (interest rate, minimum payment, etc.). */
export async function saveLiabilityProfile(
  accountId: number,
  body: {
    interestRate: number
    minimumPayment: number
    statementBalance?: number | null
    dueDay?: number | null
  },
): Promise<DebtLiabilityProfile> {
  return putJson<DebtLiabilityProfile>(`/api/debt/accounts/${accountId}`, body)
}

/** Create a saved payoff scenario and return it with its computed plan. */
export async function createScenario(body: {
  name: string
  strategy: DebtPayoffStrategy
  extraMonthlyPayment?: number
  customOrder?: number[]
  feedForecast?: boolean
  startDate?: string
}): Promise<DebtScenarioResponse> {
  return postJson<DebtScenarioResponse>('/api/debt/scenarios', body)
}
