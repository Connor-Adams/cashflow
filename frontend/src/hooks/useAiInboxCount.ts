import { usePolledCount, type PolledCount } from './usePolledCount'

type CountResponse = {
  total: number
  byKind: { transaction_audit: number }
}

const selectTotal = (r: CountResponse) => r.total

/** Pending AI review-inbox items. See `usePolledCount` for failure semantics. */
export function useAiInboxCount(): PolledCount {
  return usePolledCount<CountResponse>('/api/ai/inbox/count', selectTotal)
}
