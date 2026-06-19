import { useCallback, useEffect, useState } from 'react'
import { Clock, Copy, Trash2, UserPlus } from 'lucide-react'
import { Badge } from '@cashflow/ui'
import { Button } from '@cashflow/ui'
import { Card } from '@cashflow/ui'
import { useConfirm } from '@cashflow/ui'
import { EmptyState } from '@cashflow/ui'
import { LetterAvatar } from '@/components/ui/letter-avatar'
import { useToast } from '@/components/ui/toast'
import { InviteModal } from '@/components/settings/InviteModal'
import { buildInviteUrl, type CreatedInvite } from '@/components/settings/inviteLink'
import { deleteReq, getJson } from '../../../lib/api'
import { useAuth } from '../../../lib/useAuth'

/** GET /api/household/members row shape. */
type Member = {
  id: number
  displayName: string
  email: string
  role: string
  joinedAt: string
}

/** GET /api/invites?status=pending row shape (raw token never present). */
type PendingInvite = {
  id: number
  tokenFragment: string
  optionalEmail: string | null
  generatedAt: string
  expiresAt: string
}

/**
 * Compact "3 days ago" style relative time. No date lib is bundled, so this is
 * a small, dependency-free formatter sufficient for invite recency.
 */
function timeAgo(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const diffSec = Math.round((Date.now() - then) / 1000)
  if (diffSec < 60) return 'just now'
  const mins = Math.round(diffSec / 60)
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

export function MembersTab() {
  const auth = useAuth()
  const confirm = useConfirm()
  const { showToast } = useToast()

  const [members, setMembers] = useState<Member[]>([])
  const [invites, setInvites] = useState<PendingInvite[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [inlineErr, setInlineErr] = useState<string | null>(null)
  const [inviteOpen, setInviteOpen] = useState(false)

  // Raw tokens are revealed exactly once (at creation). Cache them by invite id
  // for this session so a freshly-created pending row can offer "Copy link";
  // rows loaded from the server can't (the link is shown only once).
  const [sessionTokens, setSessionTokens] = useState<Record<number, string>>({})

  const load = useCallback(async () => {
    setErr(null)
    try {
      const [m, i] = await Promise.all([
        getJson<Member[]>('/api/household/members'),
        getJson<PendingInvite[]>('/api/invites?status=pending'),
      ])
      setMembers(m)
      setInvites(i)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load household members')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  function handleCreated(invite: CreatedInvite) {
    setSessionTokens((prev) => ({ ...prev, [invite.id]: invite.token }))
    void load()
  }

  async function revokeInvite(invite: PendingInvite) {
    const ok = await confirm({
      title: 'Revoke this invite?',
      description: 'Revoke this invite? The link will no longer work.',
      confirmLabel: 'Revoke',
      destructive: true,
    })
    if (!ok) return
    try {
      await deleteReq(`/api/invites/${invite.id}`)
      await load()
    } catch (e) {
      showToast({
        title: e instanceof Error ? e.message : "Couldn't revoke. Try again.",
        variant: 'destructive',
      })
    }
  }

  async function removeMember(member: Member) {
    setInlineErr(null)
    // Guard the owner-self case before prompting (the backend also enforces it).
    if (member.id === auth.user?.id && member.role === 'owner') {
      setInlineErr("You can't revoke your own owner membership.")
      return
    }
    const ok = await confirm({
      title: 'Remove member?',
      description: `Remove ${member.displayName} from your household? They will lose access immediately.`,
      confirmLabel: 'Remove',
      destructive: true,
    })
    if (!ok) return
    try {
      await deleteReq(`/api/household/members/${member.id}`)
      await load()
    } catch (e) {
      const message = e instanceof Error ? e.message : "Couldn't remove member. Try again."
      // Surface the owner-self / owner-protected guard inline rather than as a toast.
      if (/owner membership|owner cannot/i.test(message)) {
        setInlineErr(message)
      } else {
        showToast({ title: message, variant: 'destructive' })
      }
    }
  }

  async function copyPending(invite: PendingInvite) {
    const token = sessionTokens[invite.id]
    if (!token) return
    try {
      await navigator.clipboard.writeText(buildInviteUrl(token))
      showToast({ title: 'Copied!', variant: 'success', durationMs: 2000 })
    } catch {
      showToast({ title: "Couldn't copy. Try again.", variant: 'destructive' })
    }
  }

  const onlySelf = members.length <= 1 && invites.length === 0

  return (
    <>
      <Card className="accountsFormCard">
        <div className="accountsCardHeader">
          <div>
            <h2>Household members</h2>
            <p className="muted">
              Invite a partner, spouse, or accountant to share household reporting.
            </p>
          </div>
          <Button type="button" onClick={() => setInviteOpen(true)}>
            <UserPlus aria-hidden="true" />
            Invite a member
          </Button>
        </div>
      </Card>

      {loading ? (
        <Card aria-busy="true">
          <p className="muted">Loading…</p>
        </Card>
      ) : err ? (
        <span className="error" role="alert">
          {err}
        </span>
      ) : onlySelf ? (
        <EmptyState
          className="text-center"
          title="You're the only member of this household."
          description="Invite a partner, spouse, or accountant to collaborate."
          actions={
            <div className="mx-auto">
              <Button type="button" onClick={() => setInviteOpen(true)}>
                <UserPlus aria-hidden="true" />
                Invite a member
              </Button>
            </div>
          }
        />
      ) : (
        <>
          <section aria-labelledby="members-active-heading" className="mb-5">
            <h3 id="members-active-heading" className="mb-2 text-sm font-semibold">
              Active members
            </h3>
            {inlineErr && (
              <p className="error mb-2" role="alert">
                {inlineErr}
              </p>
            )}
            <div className="flex flex-col gap-2">
              {members.map((member) => {
                const isSelfOwner = member.id === auth.user?.id && member.role === 'owner'
                return (
                  <Card key={member.id} className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <LetterAvatar text={member.displayName || member.email} size="md" />
                      <div className="min-w-0">
                        <div className="truncate font-medium">{member.displayName}</div>
                        <div className="muted truncate text-xs">{member.email}</div>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Badge variant={member.role === 'owner' ? 'default' : 'secondary'}>
                        {member.role === 'owner' ? 'Owner' : 'Member'}
                      </Badge>
                      {!isSelfOwner && (
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          onClick={() => void removeMember(member)}
                          aria-label={`Remove ${member.displayName}`}
                        >
                          <Trash2 aria-hidden="true" />
                          Remove
                        </Button>
                      )}
                    </div>
                  </Card>
                )
              })}
            </div>
          </section>

          <section aria-labelledby="members-pending-heading">
            <h3 id="members-pending-heading" className="mb-2 text-sm font-semibold">
              Pending invites
            </h3>
            {invites.length === 0 ? (
              <p className="muted text-sm">No pending invites.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {invites.map((invite) => {
                  const hasToken = Boolean(sessionTokens[invite.id])
                  return (
                    <Card
                      key={invite.id}
                      className="flex items-center justify-between gap-3"
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <Clock aria-hidden="true" className="text-muted-foreground" />
                        <div className="min-w-0">
                          <div className="truncate font-mono text-sm">
                            {invite.tokenFragment}…
                          </div>
                          <div className="muted truncate text-xs">
                            Generated {timeAgo(invite.generatedAt)}
                            {invite.optionalEmail ? ` · ${invite.optionalEmail}` : ''}
                          </div>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => void copyPending(invite)}
                          disabled={!hasToken}
                          title={
                            hasToken
                              ? 'Copy the invite link'
                              : 'The link is shown only once, at creation time.'
                          }
                          aria-label={`Copy link for invite ${invite.tokenFragment}`}
                        >
                          <Copy aria-hidden="true" />
                          Copy link
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          onClick={() => void revokeInvite(invite)}
                          aria-label={`Revoke invite ${invite.tokenFragment}`}
                        >
                          <Trash2 aria-hidden="true" />
                          Revoke
                        </Button>
                      </div>
                    </Card>
                  )
                })}
              </div>
            )}
          </section>
        </>
      )}

      <InviteModal open={inviteOpen} onOpenChange={setInviteOpen} onCreated={handleCreated} />
      {confirm.dialog}
    </>
  )
}
