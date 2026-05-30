import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { postJson } from '@/lib/api'
import type { Account } from '@cashflow/shared'

type MergeResult = {
  movedTransactions: number
  movedInvestmentActivities: number
  movedHoldingsSnapshots: number
  movedPlannedEvents: number
  source: Account
  target: Account
}

type Props = {
  source: Account
  accounts: Account[]
  onClose: () => void
  onSuccess: (result: MergeResult) => void
}

export function MergeAccountModal({ source, accounts, onClose, onSuccess }: Props) {
  const [targetId, setTargetId] = useState<number | ''>('')
  const [submitting, setSubmitting] = useState(false)
  const [inlineError, setInlineError] = useState<string | null>(null)

  const sourceCurrency = (source.defaultCurrency ?? 'CAD').toUpperCase()

  // Eligible targets: same currency, not already merged, different id
  const eligibleTargets = accounts.filter(
    (a) =>
      a.id !== source.id &&
      (a.defaultCurrency ?? 'CAD').toUpperCase() === sourceCurrency &&
      a.mergedIntoId == null
  )

  const selectedTarget = eligibleTargets.find((a) => a.id === targetId) ?? null

  async function handleMerge() {
    if (!targetId) return
    setSubmitting(true)
    setInlineError(null)
    try {
      const result = await postJson<MergeResult>(
        `/api/accounts/${source.id}/merge-into/${targetId}`
      )
      onSuccess(result)
    } catch (e) {
      const msg = e instanceof Error ? e.message : ''
      if (msg.includes('CURRENCY_MISMATCH')) {
        setInlineError('Accounts must be in the same currency.')
      } else if (msg.includes('TARGET_NOT_MERGEABLE')) {
        setInlineError(
          `${selectedTarget?.name ?? 'Target'} has already been merged into another account.`
        )
      } else if (msg.includes('SOURCE_ALREADY_MERGED')) {
        setInlineError(`${source.name} has already been merged into another account.`)
      } else if (msg.includes('SAME_ID')) {
        setInlineError('Cannot merge an account into itself.')
      } else {
        setInlineError(msg || 'Merge failed. Please try again.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  const noEligibleTargets = eligibleTargets.length === 0

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogHeader>
        <DialogTitle>Merge account</DialogTitle>
        <DialogDescription>
          Move all transactions from <strong>{source.name}</strong> into another account.
        </DialogDescription>
      </DialogHeader>

      <DialogBody>
        {noEligibleTargets ? (
          <p
            style={{ color: 'var(--muted-foreground)', fontSize: '0.9em' }}
            title="Need at least two same-currency accounts to merge."
          >
            No eligible target accounts. You need at least two same-currency accounts to merge.
          </p>
        ) : (
          <Label htmlFor="merge-target-select">
            Merge into
            <select
              id="merge-target-select"
              value={targetId}
              onChange={(e) => {
                setTargetId(e.target.value ? Number(e.target.value) : '')
                setInlineError(null)
              }}
              style={{ marginTop: '0.25rem' }}
            >
              <option value="">— choose target account —</option>
              {eligibleTargets.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({(a.defaultCurrency ?? 'CAD').toUpperCase()})
                </option>
              ))}
            </select>
          </Label>
        )}

        {selectedTarget && (
          <p style={{ marginTop: '0.75rem', fontSize: '0.9em' }}>
            This action will move all transactions from{' '}
            <strong>{source.name}</strong> to{' '}
            <strong>{selectedTarget.name}</strong>.
          </p>
        )}

        <p
          style={{
            marginTop: '0.75rem',
            fontSize: '0.85em',
            color: 'var(--muted-foreground)',
            fontStyle: 'italic',
          }}
        >
          Warning: Merge is not currently reversible.
        </p>

        {inlineError && (
          <p
            role="alert"
            style={{ marginTop: '0.5rem', fontSize: '0.85em', color: 'var(--destructive)' }}
          >
            {inlineError}
          </p>
        )}
      </DialogBody>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="primary"
          onClick={() => void handleMerge()}
          disabled={!targetId || submitting || noEligibleTargets}
        >
          {submitting ? 'Merging…' : 'Merge'}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
