import { usePolledCount, type PolledCount } from './usePolledCount'

type InsightsListResponse = {
  data: Array<{ id: number; status: 'open' | 'dismissed' | 'resolved' }>
}

const selectLength = (r: InsightsListResponse) => r.data.length

/**
 * Returns the number of OPEN insights so the sidebar nav entry can display
 * a count badge. Polls on a 5-minute interval and re-fetches on window
 * focus. Shares `usePolledCount` with `useAiInboxCount` so the two badges
 * behave consistently (including keeping the last good value on failure).
 */
export function useInsightsCount(): PolledCount {
  return usePolledCount<InsightsListResponse>('/api/insights?status=open', selectLength)
}
