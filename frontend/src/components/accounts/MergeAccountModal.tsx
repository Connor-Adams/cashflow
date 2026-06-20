import { useMemo, useState } from 'react'
import { Dialog } from '@connor-adams/designsystem'
import { Button } from '@connor-adams/designsystem'
import { Alert } from '@connor-adams/designsystem'
import { Label } from '@connor-adams/designsystem'
import { postJson } from '../../lib/api'
import type { Account, AccountMergeResult } from '../../types/api'

type MergeAccountModalProps = {
  /** The source account being merged away. */
  source: Account
  /** All active (un-merged) accounts; the target dropdown filters this. */
  accounts: Account[]
  onClose: () => void
  /** Called after a successful merge with the moved-transaction count. */
  onMerged: (result: AccountMergeResult) => void
}

function currencyOf(a: Account): string {
  return (a.defaultCurrency ?? 'CAD').toUpperCase()
}

/** Map a backend merge error code to a human-readable inline message. */
function mergeErrorMessage(code: string, source: Account, target: Account | null): string {
  switch (code) {
    case 'CURRENCY_MISMATCH':
      return `Accounts must be in the same currency. Source: ${currencyOf(source)}; Target: ${
        target ? currencyOf(target) : '—'
      }.`
    case 'TARGET_NOT_MERGEABLE':
      return `${target?.name ?? 'That account'} has already been merged into another account.`
    case 'SOURCE_ALREADY_MERGED':
      return `${source.name} has already been merged into another account.`
    case 'SAME_ID':
      return 'An account cannot be merged into itself.'
    default:
      return code
  }
}

/**
 * Merge-accounts modal (#287). Lets the user pick a same-currency target,
 * shows a preview of how many transactions will move, warns the merge is not
 * reversible, and performs the merge. Merge is disabled until a valid
 * same-currency target is selected.
 */
export function MergeAccountModal({ source, accounts, onClose, onMerged }: MergeAccountModalProps) {
  const [targetId, setTargetId] = useState<number | ''>('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Eligible targets: a different account, same currency, not itself merged.
  const eligibleTargets = useMemo(
    () =>
      accounts.filter(
        (a) =>
          a.id !== source.id &&
          a.mergedIntoId == null &&
          currencyOf(a) === currencyOf(source),
      ),
    [accounts, source],
  )

  const target = eligibleTargets.find((a) => a.id === targetId) ?? null
  const canMerge = target != null && !busy

  async function onConfirm() {
    if (!target) return
    setBusy(true)
    setError(null)
    try {
      const result = await postJson<AccountMergeResult>(
        `/api/accounts/${source.id}/merge-into/${target.id}`,
        {},
      )
      onMerged(result)
    } catch (e) {
      const code = e instanceof Error ? e.message : 'MERGE_FAILED'
      setError(mergeErrorMessage(code, source, target))
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onClose={() => { if (!busy) onClose() }}
      title={<>Merge accounts</>}
      description={
        <>
          Move everything from “{source.name}” into another account. The source is kept,
          read-only, for audit.
        </>
      }
      footer={
        <>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void onConfirm()} disabled={!canMerge}>
            {busy ? 'Merging…' : 'Merge'}
          </Button>
        </>
      }
    >
        {eligibleTargets.length === 0 ? (
          <Alert variant="info">
            Need at least two same-currency accounts to merge. No eligible{' '}
            {currencyOf(source)} target found.
          </Alert>
        ) : (
          <div className="flex flex-col gap-3">
            <Label htmlFor="merge-target">
              Merge into
              <select
                id="merge-target"
                value={targetId}
                onChange={(e) => {
                  setError(null)
                  setTargetId(e.target.value === '' ? '' : Number(e.target.value))
                }}
                disabled={busy}
              >
                <option value="">Select a target account…</option>
                {eligibleTargets.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({currencyOf(a)})
                  </option>
                ))}
              </select>
            </Label>

            {target ? (
              <p className="text-sm text-muted-foreground" data-testid="merge-preview">
                This will move all transactions and planned events from{' '}
                <strong>{source.name}</strong> to <strong>{target.name}</strong>.
              </p>
            ) : null}

            <Alert variant="warning">Merge is not currently reversible.</Alert>

            {error ? <Alert variant="error">{error}</Alert> : null}
          </div>
        )}
    </Dialog>
  )
}
