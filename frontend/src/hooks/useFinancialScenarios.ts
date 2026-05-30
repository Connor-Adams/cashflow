import { useCallback, useEffect, useState } from 'react'
import { getJson, postJson, deleteReq } from '@/lib/api'
import type {
  CreateScenarioInput,
  FinancialScenario,
  FinancialScenariosListResponse,
} from '@/types/api'

// NOTE: this is the household-finance scenario planner (issue #213). It is
// deliberately distinct from `useScenarios.ts`, which is the TAX scenario hook
// (/api/tax/personal-scenarios). The two share the word "scenario" but model
// unrelated domains.

type AsyncState<T> = { data: T | null; loading: boolean; error: Error | null }

/**
 * List saved financial scenarios for the current household. Returns the raw
 * array plus a `refresh` to re-fetch after a create / delete.
 */
export function useFinancialScenarios(): AsyncState<FinancialScenario[]> & {
  refresh: () => void
} {
  const [state, setState] = useState<AsyncState<FinancialScenario[]>>({
    data: null,
    loading: true,
    error: null,
  })
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let cancelled = false
    setState((s) => ({ ...s, loading: true, error: null }))
    getJson<FinancialScenariosListResponse>('/api/financial-scenarios')
      .then((res) => {
        if (!cancelled) setState({ data: res.data, loading: false, error: null })
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

/** Create a scenario (computes + persists server-side). */
export async function createFinancialScenario(
  input: CreateScenarioInput,
): Promise<FinancialScenario> {
  return postJson<FinancialScenario>('/api/financial-scenarios', input)
}

/** Fetch one scenario by id — recomputes against current data server-side. */
export async function getFinancialScenario(
  id: number,
): Promise<FinancialScenario> {
  return getJson<FinancialScenario>(`/api/financial-scenarios/${id}`)
}

/** Delete a scenario. */
export async function deleteFinancialScenario(id: number): Promise<void> {
  return deleteReq(`/api/financial-scenarios/${id}`)
}
