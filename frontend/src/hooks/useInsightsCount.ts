import { useEffect, useState } from 'react'
import { getJson } from '@/lib/api'

type InsightsListResponse = {
  data: Array<{ id: number; status: 'open' | 'dismissed' | 'resolved' }>
}

const POLL_MS = 5 * 60 * 1000

/**
 * Returns the number of OPEN insights so the sidebar nav entry can display
 * a count badge. Polls on a 5-minute interval and re-fetches on window
 * focus. Mirrors `useAiInboxCount` so the two badges behave consistently.
 */
export function useInsightsCount(): { count: number; loading: boolean } {
  const [count, setCount] = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function fetchCount() {
      try {
        const r = await getJson<InsightsListResponse>('/api/insights?status=open')
        if (!cancelled) setCount(r.data.length)
      } catch {
        if (!cancelled) setCount(0)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void fetchCount()
    const interval = setInterval(() => void fetchCount(), POLL_MS)
    const onFocus = () => void fetchCount()
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      clearInterval(interval)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  return { count, loading }
}
