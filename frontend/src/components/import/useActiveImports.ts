import { useEffect, useRef, useState } from 'react'
import { getJson } from '../../lib/api'

export type BatchSummary = {
  id: string; status: 'pending' | 'processing' | 'done' | 'failed'
  total: number; processed: number; succeeded: number; failed: number; skipped: number
  createdAt: string; startedAt: string | null
}

export function useActiveImports(pollMs = 3000) {
  const [batches, setBatches] = useState<BatchSummary[]>([])
  const prevActive = useRef<Set<string>>(new Set())
  const [justFinished, setJustFinished] = useState<BatchSummary | null>(null)

  useEffect(() => {
    let active = true
    const tick = async () => {
      try {
        const all = await getJson<BatchSummary[]>('/api/import/pdf-batches')
        if (!active) return
        setBatches(all)
        const nowActive = new Set(all.filter((b) => b.status === 'pending' || b.status === 'processing').map((b) => b.id))
        for (const id of prevActive.current) {
          if (!nowActive.has(id)) {
            const done = all.find((b) => b.id === id)
            if (done) setJustFinished(done)
          }
        }
        prevActive.current = nowActive
      } catch { /* keep polling */ }
      if (active) setTimeout(tick, pollMs)
    }
    void tick()
    return () => { active = false }
  }, [pollMs])

  const activeBatches = batches.filter((b) => b.status === 'pending' || b.status === 'processing')
  return { activeBatches, justFinished, clearFinished: () => setJustFinished(null) }
}
