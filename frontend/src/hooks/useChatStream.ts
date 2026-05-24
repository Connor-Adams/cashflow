import { useCallback, useRef, useState } from 'react'
import type { ChatStreamEvent } from '@cashflow/shared'

const base = import.meta.env.VITE_API_BASE ?? ''

export type { ChatStreamEvent }

/**
 * SSE consumer for `POST /api/chat/threads/:id/messages`.
 *
 * EventSource cannot POST, so we use `fetch` + a manual ReadableStream
 * decoder. Splits the incoming text on the SSE record separator (`\n\n`),
 * extracts `event:` and `data:` lines, JSON-parses `data`, and forwards
 * each typed event through `onEvent`.
 *
 * `send` aborts any in-flight stream before starting a new one. `cancel`
 * aborts the current stream — the server attaches `req.on('close')` to its
 * upstream OpenAI request so the model halts mid-token.
 */
export function useChatStream() {
  const [streaming, setStreaming] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const send = useCallback(
    async (
      threadId: number,
      message: string,
      onEvent: (ev: ChatStreamEvent) => void,
    ): Promise<void> => {
      abortRef.current?.abort()
      const ac = new AbortController()
      abortRef.current = ac
      setStreaming(true)
      try {
        const res = await fetch(`${base}/api/chat/threads/${threadId}/messages`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message }),
          signal: ac.signal,
        })
        if (!res.ok || !res.body) {
          let serverMessage: string | undefined
          try {
            const body = (await res.json()) as { error?: string; message?: string }
            serverMessage = body.error ?? body.message
          } catch {
            /* non-JSON body — fall back to HTTP status */
          }
          onEvent({
            type: 'error',
            message: serverMessage ?? `HTTP ${res.status}`,
          })
          return
        }
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        try {
          while (true) {
            const { value, done } = await reader.read()
            if (done) break
            buf += decoder.decode(value, { stream: true })
            let idx: number
            while ((idx = buf.indexOf('\n\n')) !== -1) {
              const raw = buf.slice(0, idx)
              buf = buf.slice(idx + 2)
              const parsed = parseSseRecord(raw)
              if (parsed) onEvent(parsed)
            }
          }
          if (buf.length > 0) {
            const parsed = parseSseRecord(buf)
            if (parsed) onEvent(parsed)
          }
        } finally {
          reader.releaseLock()
        }
      } catch (e) {
        if ((e as Error).name !== 'AbortError') {
          onEvent({ type: 'error', message: (e as Error).message })
        }
      } finally {
        setStreaming(false)
        abortRef.current = null
      }
    },
    [],
  )

  const cancel = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  return { send, cancel, streaming }
}

/**
 * Parse one SSE record (the chunk between two `\n\n` separators).
 *
 * Record format per spec:
 *   event: <name>
 *   data: <json>
 *
 * Multi-line `data:` fields are joined; lines starting with `:` are comments
 * and ignored. Returns `null` when the record is incomplete or the data is
 * not valid JSON (we silently skip malformed events rather than crash).
 */
function parseSseRecord(raw: string): ChatStreamEvent | null {
  let eventName = ''
  const dataLines: string[] = []
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) continue
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      // Per SSE spec, a single leading space after the colon is stripped.
      const v = line.slice(5)
      dataLines.push(v.startsWith(' ') ? v.slice(1) : v)
    }
  }
  if (!eventName || dataLines.length === 0) return null
  const data = dataLines.join('\n')
  try {
    return JSON.parse(data) as ChatStreamEvent
  } catch {
    return null
  }
}
