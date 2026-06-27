/**
 * Settings → Account tab. Home of the owner-only "danger zone": permanent
 * deletion of the household via the right-to-erasure endpoint (issue #850).
 *
 * Owner-gated twice over — the sidebar entry is `ownerOnly`, and this tab also
 * guards directly so a non-owner who deep-links here sees an explanation, not
 * a destructive button (the backend would 403 them regardless).
 */
import { useState } from 'react'
import { Button, Card } from '@connor-adams/designsystem'
import { useAuth } from '@/lib/useAuth'
import { DeleteAccountModal } from './DeleteAccountModal'

export function AccountTab() {
  const auth = useAuth()
  const [modalOpen, setModalOpen] = useState(false)

  const household = auth.user?.household ?? null
  const isOwner = household?.role === 'owner'

  if (!household || !isOwner) {
    return (
      <Card className="p-4">
        <h2 className="text-base font-semibold">Account</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Only the household owner can delete the account.
        </p>
      </Card>
    )
  }

  function handleDeleted() {
    // The session cookie is dead and every in-memory household value is now
    // stale. Hard-navigate to the root so the app fully reloads into the login
    // screen with nothing cached.
    window.location.assign('/')
  }

  return (
    <Card className="border-danger/40 p-4">
      <h2 className="text-base font-semibold text-danger">Delete account &amp; household</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Permanently delete <strong>{household.name}</strong> and everyone in it —
        all transactions, accounts, receipts, and exports. This is irreversible.
      </p>
      <div className="mt-4">
        <Button variant="destructive" onClick={() => setModalOpen(true)}>
          Delete account…
        </Button>
      </div>

      <DeleteAccountModal
        open={modalOpen}
        householdName={household.name}
        onClose={() => setModalOpen(false)}
        onDeleted={handleDeleted}
      />
    </Card>
  )
}
