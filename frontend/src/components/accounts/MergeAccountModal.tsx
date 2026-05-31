import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { NativeSelect } from '@/components/ui/native-select'
import { useToast } from '@/components/ui/toast'
import { postJson } from '../../lib/api'
import type { Account } from '../../types/api'

interface MergeResult {
  movedTransactions: number
  movedPlannedEvents: number
}

interface Props {
  source: Account
  eligibleTargets: Account[]
  onClose: () => void
  onMerged: () => void
}

export function MergeAccountModal({ source, eligibleTargets, onClose, onMerged }: Props) {
  const { showToast } = useToast()
  const [targetId, setTargetId] = useState<string>('')
  const [merging, setMerging] = useState(false)
  const [confirmStep, setConfirmStep] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const target = eligibleTargets.find((a) => String(a.id) === targetId) ?? null

  function handleSelectTarget(value: string) {
    setTargetId(value)
    setConfirmStep(false)
    setError(null)
  }

  async function doMerge() {
    if (!target) return
    setMerging(true)
    setError(null)
    try {
      const result = await postJson<MergeResult>(
        `/api/accounts/${source.id}/merge-into/${target.id}`,
        {},
      )
      showToast({
        title: `Merged ${source.name} into ${target.name}: moved ${result.movedTransactions} transactions.`,
        variant: 'success',
      })
      onMerged()
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Merge failed'
      setError(msg)
      setMerging(false)
      setConfirmStep(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Merge accounts"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <Card className="w-full max-w-md p-5 space-y-4">
        <h2 className="text-lg font-semibold">Merge accounts</h2>

        {eligibleTargets.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Need at least two same-currency accounts to merge.
          </p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Move all transactions and planned events from{' '}
              <strong>{source.name}</strong> into the selected account.
            </p>

            <div>
              <label className="block text-sm font-medium mb-1" htmlFor="merge-target">
                Merge into
              </label>
              <NativeSelect
                id="merge-target"
                value={targetId}
                onChange={(e) => handleSelectTarget(e.target.value)}
              >
                <option value="">— select account —</option>
                {eligibleTargets.map((a) => (
                  <option key={a.id} value={String(a.id)}>
                    {a.name} ({a.defaultCurrency ?? 'CAD'})
                  </option>
                ))}
              </NativeSelect>
            </div>

            {target && !confirmStep && (
              <div className="rounded-md bg-muted/30 border border-border p-3 text-sm space-y-1">
                <p>
                  This will move all transactions from <strong>{source.name}</strong> to{' '}
                  <strong>{target.name}</strong>.
                </p>
                <p className="text-muted-foreground">The source account will be hidden and kept for audit.</p>
              </div>
            )}

            {confirmStep && target && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm space-y-1">
                <p className="font-medium text-destructive">Merge is not currently reversible.</p>
                <p>Confirm merging <strong>{source.name}</strong> into <strong>{target.name}</strong>?</p>
              </div>
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}
          </>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={merging}>
            Cancel
          </Button>
          {eligibleTargets.length > 0 && !confirmStep && (
            <Button
              type="button"
              disabled={!targetId || merging}
              onClick={() => setConfirmStep(true)}
            >
              Merge…
            </Button>
          )}
          {confirmStep && (
            <Button
              type="button"
              variant="destructive"
              disabled={merging}
              onClick={() => void doMerge()}
            >
              {merging ? 'Merging…' : 'Merge'}
            </Button>
          )}
        </div>
      </Card>
    </div>
  )
}
