import { useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { postJson } from '@/lib/api'
import type { Account } from '@cashflow/shared'

type Props = {
  source: Account
  allAccounts: Account[]
  onDone: (movedTransactions: number, targetName: string) => void
  onCancel: () => void
}

type MergeResult = {
  movedTransactions: number
  movedPlannedEvents: number
  source: Account
  target: Account
}

export function MergeAccountModal({ source, allAccounts, onDone, onCancel }: Props) {
  const [targetId, setTargetId] = useState<number | ''>('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const eligibleTargets = allAccounts.filter(
    (a) =>
      a.id !== source.id &&
      !a.mergedIntoId &&
      (a.defaultCurrency ?? 'CAD') === (source.defaultCurrency ?? 'CAD'),
  )

  const selectedTarget = eligibleTargets.find((a) => a.id === targetId) ?? null

  async function handleMerge() {
    if (!targetId) return
    setLoading(true)
    setError(null)
    try {
      const result = await postJson<MergeResult>(
        `/api/accounts/${source.id}/merge-into/${targetId}`,
      )
      onDone(result.movedTransactions, result.target.name)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Merge failed. Try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onCancel}
    >
      <div
        className="bg-background rounded-lg border shadow-lg w-full max-w-md p-6 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold">Merge accounts</h2>

        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">
            Merging <strong>{source.name}</strong> ({source.defaultCurrency ?? 'CAD'}).
          </p>
          <p className="text-sm text-muted-foreground">
            All transactions and planned events will move to the target account.
            The source account will become hidden and read-only.
          </p>
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium">Merge into</label>
          {eligibleTargets.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">
              No eligible target accounts. Need at least one other{' '}
              {source.defaultCurrency ?? 'CAD'} account that hasn't been merged.
            </p>
          ) : (
            <select
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={targetId}
              onChange={(e) => setTargetId(Number(e.target.value) || '')}
            >
              <option value="">— Select a target account —</option>
              {eligibleTargets.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.defaultCurrency ?? 'CAD'})
                </option>
              ))}
            </select>
          )}
        </div>

        {selectedTarget && (
          <div className="rounded-md bg-muted/50 border px-3 py-2 text-sm space-y-1">
            <p>
              <strong>{source.name}</strong> → <strong>{selectedTarget.name}</strong>
            </p>
            <p className="text-muted-foreground">
              All transactions, planned events, and recurring items associated with{' '}
              {source.name} will be reassigned to {selectedTarget.name}.
            </p>
          </div>
        )}

        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-950/20 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>Merge is not currently reversible.</span>
        </div>

        {error && (
          <p className="text-sm text-destructive">{error}</p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" onClick={onCancel} disabled={loading}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void handleMerge()}
            disabled={!targetId || loading || eligibleTargets.length === 0}
          >
            {loading ? 'Merging…' : 'Merge'}
          </Button>
        </div>
      </div>
    </div>
  )
}
