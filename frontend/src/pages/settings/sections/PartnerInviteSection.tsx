import { useState } from 'react'
import { Button, Icon } from '@connor-adams/designsystem'
import { Card } from '@connor-adams/designsystem'
import { Input } from '@connor-adams/designsystem'
import { postJson } from '@/lib/api'

export function PartnerInviteSection() {
  const [invite, setInvite] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const inviteUrl = invite
    ? `${window.location.origin}${window.location.pathname}?invite=${encodeURIComponent(invite)}`
    : null

  async function createInvite() {
    setErr(null)
    try {
      const data = await postJson<{ token: string }>('/api/auth/invites')
      setInvite(data.token)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not create invite')
    }
  }

  return (
    <Card className="accountsFormCard">
      <div className="accountsCardHeader">
        <div>
          <h2>Partner invite</h2>
          <p className="muted">Invite links let another user join shared household reporting.</p>
        </div>
        <Button type="button" onClick={createInvite}>
          <Icon name="link" aria-hidden="true" />
          Create invite
        </Button>
      </div>
      {inviteUrl && (
        <Input readOnly value={inviteUrl} onFocus={(e) => e.currentTarget.select()} />
      )}
      {err && <p className="muted" style={{ color: 'var(--color-error)' }}>{err}</p>}
    </Card>
  )
}
