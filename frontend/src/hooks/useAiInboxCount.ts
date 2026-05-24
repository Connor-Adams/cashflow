import { useEffect, useState } from 'react'
import { getJson } from '@/lib/api'

type CountResponse = {
  total: number
  byKind: { transaction_audit: number; financial_insight: number; rule_proposal: number }
}

const POLL_MS = 5 * 60 * 1000

export function useAiInboxCount(): { count: number; loading: boolean } {
  const [count, setCount] = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function fetchCount() {
      try {
        const r = await getJson<CountResponse>('/api/ai/inbox/count')
        if (!cancelled) setCount(r.total)
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
