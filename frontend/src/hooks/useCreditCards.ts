import { useCallback, useEffect, useState } from 'react'
import { getJson, postJson, putJson } from '@/lib/api'
import type {
  CreditCardsOverview,
  CreditCardProfile,
  CardPaymentStrategy,
  CreditCardPaymentResponse,
  CardPaymentPlannedEvent,
} from '@/types/api'

type AsyncState<T> = { data: T | null; loading: boolean; error: Error | null }

/**
 * Load the credit-card payment overview — every credit_card account with its
 * current/statement/minimum balances, due-date warnings, and autopay status.
 * Mirrors useDebt/useForecast: returns {data, loading, error, refresh}.
 */
export function useCreditCards(): AsyncState<CreditCardsOverview> & { refresh: () => void } {
  const [state, setState] = useState<AsyncState<CreditCardsOverview>>({
    data: null,
    loading: true,
    error: null,
  })
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let cancelled = false
    setState((s) => ({ ...s, loading: true, error: null }))
    getJson<CreditCardsOverview>('/api/credit-cards')
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
  }, [nonce])

  const refresh = useCallback(() => setNonce((n) => n + 1), [])
  return { ...state, refresh }
}

/** Upsert a card's payment metadata (statement, minimum, due day, autopay…). */
export async function saveCardProfile(
  accountId: number,
  body: {
    statementBalance?: number | null
    minimumPayment?: number
    dueDay?: number | null
    statementDate?: string | null
    autopayEnabled?: boolean
    autopayType?: string | null
    autopayAmount?: number | null
    paymentAccountId?: number | null
  },
): Promise<CreditCardProfile> {
  return putJson<CreditCardProfile>(`/api/credit-cards/${accountId}`, body)
}

/** Materialize a planned payment for a card into the forecast. */
export async function planCardPayment(
  accountId: number,
  body: { amountStrategy: CardPaymentStrategy },
): Promise<CreditCardPaymentResponse> {
  return postJson<CreditCardPaymentResponse>(`/api/credit-cards/${accountId}/payment`, body)
}

/** Mark a card's planned payment as paid, optionally linking a transaction. */
export async function markCardPaymentPaid(
  accountId: number,
  body: { plannedEventId?: number; transactionId?: number },
): Promise<{ plannedEvent: CardPaymentPlannedEvent }> {
  return postJson<{ plannedEvent: CardPaymentPlannedEvent }>(
    `/api/credit-cards/${accountId}/mark-paid`,
    body,
  )
}
