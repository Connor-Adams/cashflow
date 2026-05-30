import { useEffect, useRef, useState } from 'react'

type PreviewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; matches: number }
  | { status: 'error'; message: string }

type Props = {
  pattern: string
  matchType: 'substring' | 'regex'
}

const base = (import.meta as { env?: { VITE_API_BASE?: string } }).env?.VITE_API_BASE ?? ''

export function RulePatternPreview({ pattern, matchType }: Props) {
  const [state, setState] = useState<PreviewState>({ status: 'idle' })
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const seqRef = useRef(0)

  useEffect(() => {
    if (timerRef.current != null) clearTimeout(timerRef.current)

    if (!pattern) {
      setState({ status: 'idle' })
      return
    }

    setState({ status: 'loading' })

    timerRef.current = setTimeout(() => {
      const seq = ++seqRef.current

      void fetch(`${base}/api/rules/preview-pattern`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pattern, matchType }),
      })
        .then(async (res) => {
          if (seqRef.current !== seq) return
          const body = (await res.json()) as {
            matches?: number
            error?: string
            message?: string
          }
          if (!res.ok) {
            const msg = body.message ?? body.error ?? res.statusText
            setState({ status: 'error', message: msg })
          } else {
            setState({ status: 'ok', matches: body.matches ?? 0 })
          }
        })
        .catch(() => {
          if (seqRef.current !== seq) return
          setState({ status: 'error', message: 'Could not reach server' })
        })
    }, 300)

    return () => {
      if (timerRef.current != null) clearTimeout(timerRef.current)
    }
  }, [pattern, matchType])

  if (state.status === 'idle') return null

  if (state.status === 'loading') {
    return <span className="rulePatternPreview muted">Counting…</span>
  }

  if (state.status === 'error') {
    return (
      <span className="rulePatternPreview error">
        Invalid pattern: {state.message}
      </span>
    )
  }

  const count = state.matches
  const label =
    count >= 500
      ? 'matches 500+ existing transactions'
      : `matches ${count} existing transaction${count === 1 ? '' : 's'}`

  return <span className="rulePatternPreview muted">{label}</span>
}
