import { useEffect, useState } from 'react'
import { postJson } from '@/lib/api'

type State =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'done'; matches: number }
  | { kind: 'error'; message: string }

type Props = {
  pattern: string
  matchType: string
}

export function RulePatternPreview({ pattern, matchType }: Props) {
  const [state, setState] = useState<State>({ kind: 'idle' })

  useEffect(() => {
    if (!pattern.trim()) {
      setState({ kind: 'idle' })
      return
    }
    setState({ kind: 'loading' })
    const timer = setTimeout(() => {
      postJson<{ matches: number }>('/api/rules/preview-pattern', { pattern, matchType })
        .then((data) => setState({ kind: 'done', matches: data.matches }))
        .catch((e: unknown) => {
          const msg = e instanceof Error ? e.message : String(e)
          if (msg === 'INVALID_PATTERN') {
            setState({ kind: 'error', message: 'Invalid regex pattern' })
          } else {
            setState({ kind: 'idle' })
          }
        })
    }, 300)
    return () => clearTimeout(timer)
  }, [pattern, matchType])

  if (state.kind === 'idle') return null
  if (state.kind === 'loading') {
    return <span className="text-sm text-muted-foreground italic">Counting…</span>
  }
  if (state.kind === 'error') {
    return <span className="text-sm text-red-600">{state.message}</span>
  }
  const count = state.matches
  const label =
    count >= 500
      ? 'matches 500+ existing transactions'
      : `matches ${count} existing transaction${count !== 1 ? 's' : ''}`
  return <span className="text-sm text-muted-foreground italic">{label}</span>
}
