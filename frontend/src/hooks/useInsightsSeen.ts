import { useCallback, useState } from 'react'

function storageKey(userId: string): string {
  return `cashflow:ai-insights:lastSeen:${userId}`
}

function getStorage(): Storage | null {
  try {
    // Use window.localStorage to avoid Node 26 experimental global shadowing
    // the jsdom-provided Storage in test environments.
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}

function readSeen(userId: string): Set<string> {
  const storage = getStorage()
  if (!storage) return new Set()
  try {
    const raw = storage.getItem(storageKey(userId))
    if (!raw) return new Set()
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((v): v is string => typeof v === 'string'))
  } catch {
    return new Set()
  }
}

function writeSeen(userId: string, seen: Set<string>): void {
  const storage = getStorage()
  if (!storage) return
  const arr = Array.from(seen).slice(-100)
  storage.setItem(storageKey(userId), JSON.stringify(arr))
}

function signature(period: string, metric: string, title: string): string {
  return `${period}::${metric}::${title}`
}

export function useInsightsSeen(userId: string) {
  const [seen, setSeen] = useState<Set<string>>(() => readSeen(userId))

  const isSeen = useCallback(
    (period: string, metric: string, title: string): boolean =>
      seen.has(signature(period, metric, title)),
    [seen],
  )

  const markSeen = useCallback(
    (period: string, metric: string, title: string) => {
      setSeen((prev) => {
        const next = new Set(prev)
        next.add(signature(period, metric, title))
        writeSeen(userId, next)
        return next
      })
    },
    [userId],
  )

  return { isSeen, markSeen }
}
