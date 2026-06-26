/**
 * Destructive confirmation for the right-to-erasure endpoint (issue #850).
 *
 * The user must type their household name *exactly* before the destructive
 * action unlocks — a deliberate friction gate for an irreversible call that
 * wipes the entire household. Calls DELETE /api/me/account with
 * `{ confirm: <household name> }`; on success the parent handles the redirect
 * (the session cookie is already dead server-side).
 */
import { useState } from 'react'
import { Dialog, Button, Input, Label } from '@connor-adams/designsystem'
import { deleteAccount } from '@/lib/api'

type DeleteAccountModalProps = {
  open: boolean
  /** Exact household name the user must retype to confirm. */
  householdName: string
  onClose: () => void
  /** Fired after the erasure succeeds — parent redirects to the login screen. */
  onDeleted: () => void
}

export function DeleteAccountModal({
  open,
  householdName,
  onClose,
  onDeleted,
}: DeleteAccountModalProps) {
  const [typed, setTyped] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const matches = typed === householdName

  if (!open) return null

  async function confirmDelete() {
    if (!matches || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      await deleteAccount(householdName)
      onDeleted()
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Could not delete the account. Try again.',
      )
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      open
      // Block dismiss-while-deleting so a mid-flight close can't strand the UI.
      onClose={submitting ? () => {} : onClose}
      title="Delete account & household"
      description="This permanently deletes your household and every member, all financial data, receipts, and exports. It cannot be undone."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => void confirmDelete()}
            disabled={!matches || submitting}
          >
            {submitting ? 'Deleting…' : 'Delete everything'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Label htmlFor="delete-account-confirm">
          Type <strong>{householdName}</strong> to confirm
          <Input
            id="delete-account-confirm"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-label="Household name confirmation"
            placeholder={householdName}
          />
        </Label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  )
}
