import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { postJson } from '@/lib/api'

type CategorizeResult = { categorized: number }
type Status =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; result: CategorizeResult }
  | { kind: 'error'; message: string }

export function CategorizeItemsButton() {
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  async function handleClick() {
    if (status.kind === 'running') return
    setStatus({ kind: 'running' })
    try {
      const result = await postJson<CategorizeResult>('/api/external-orders/categorize-items')
      setStatus({ kind: 'done', result })
    } catch (e) {
      setStatus({ kind: 'error', message: e instanceof Error ? e.message : 'Categorization failed' })
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
        {status.kind === 'running' ? 'Categorizing…' : 'Categorize items'}
      </Button>
      {status.kind === 'done' && (
        <span className="text-sm text-muted-foreground">
          {status.result.categorized === 0
            ? 'Everything’s already categorized.'
            : `Categorized ${status.result.categorized} item${status.result.categorized === 1 ? '' : 's'}.`}
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
