import { useEffect, useState } from 'react'
import { getJson } from '@/lib/api'
import type { AiStatus } from '@cashflow/shared'

/**
 * Fetches `/api/ai/status` once on mount. Returns `null` while loading.
 *
 * On any error (network, 4xx/5xx) it resolves to `{ openai: false, chat: false }`
 * so callers can treat AI features as unavailable rather than crash.
 */
export function useAiStatus(): AiStatus | null {
  const [status, setStatus] = useState<AiStatus | null>(null)

  useEffect(() => {
    let mounted = true
    getJson<AiStatus>('/api/ai/status')
      .then((s) => {
        if (mounted) setStatus(s)
      })
      .catch(() => {
        if (mounted) setStatus({ openai: false, chat: false })
      })
    return () => {
      mounted = false
    }
  }, [])

  return status
}

export type { AiStatus }
