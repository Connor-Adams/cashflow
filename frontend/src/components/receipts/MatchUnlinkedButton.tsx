import { useState } from 'react'
import { Button } from '@connor-adams/designsystem'
import { postJson } from '@/lib/api'

type MatchResult = { processed: number; linksCreated: number }
type Status =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; result: MatchResult }
  | { kind: 'error'; message: string }

export function MatchUnlinkedButton() {
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  async function handleClick() {
    if (status.kind === 'running') return
    setStatus({ kind: 'running' })
    try {
      const result = await postJson<MatchResult>('/api/external-orders/match-unlinked')
      setStatus({ kind: 'done', result })
    } catch (e) {
      setStatus({ kind: 'error', message: e instanceof Error ? e.message : 'Match failed' })
    }
  }

  return (
    <div className="flex items-center gap-3">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={status.kind === 'running'}
        onClick={() => void handleClick()}
      >
        {status.kind === 'running' ? 'Matching…' : 'Match unlinked receipts'}
      </Button>
      {status.kind === 'done' && (
        <span className="text-sm text-muted-foreground">
          {status.result.linksCreated === 0
            ? 'No new matches found.'
            : `Linked ${status.result.linksCreated} of ${status.result.processed} receipts.`}
        </span>
      )}
      {status.kind === 'error' && (
        <span className="text-sm text-destructive" role="alert">
          {status.message}
        </span>
      )}
    </div>
  )
}
