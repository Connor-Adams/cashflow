import { useState } from 'react'
import type { FormEvent } from 'react'
import { Check, Copy } from 'lucide-react'
import { Button } from '@cashflow/ui'
import {
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@cashflow/ui'
import { Input } from '@cashflow/ui'
import { Label } from '@cashflow/ui'
import { useToast } from '@/components/ui/toast'
import { postJson } from '@/lib/api'
import { buildInviteUrl, type CreatedInvite } from './inviteLink'

type InviteModalProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Bubbles the created invite (incl. raw token) up so the list can refetch. */
  onCreated?: (invite: CreatedInvite) => void
}

export function InviteModal({ open, onOpenChange, onCreated }: InviteModalProps) {
  const { showToast } = useToast()
  const [email, setEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [created, setCreated] = useState<CreatedInvite | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  function reset() {
    setEmail('')
    setSubmitting(false)
    setCreated(null)
    setErr(null)
    setCopied(false)
  }

  function close() {
    reset()
    onOpenChange(false)
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setErr(null)
    setSubmitting(true)
    try {
      const trimmed = email.trim()
      const invite = await postJson<CreatedInvite>('/api/invites', {
        optionalEmail: trimmed === '' ? undefined : trimmed,
      })
      setCreated(invite)
      onCreated?.(invite)
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't create the invite. Try again.")
    } finally {
      setSubmitting(false)
    }
  }

  async function copyLink() {
    if (!created) return
    const url = buildInviteUrl(created.token)
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      showToast({ title: 'Copied!', variant: 'success', durationMs: 2000 })
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard permission denied — select the field so the user can copy
      // manually, and tell them what happened.
      const input = document.getElementById('invite-link-field') as HTMLInputElement | null
      input?.select()
      setErr('Copy failed — select the link above and copy it manually.')
    }
  }

  if (!open) return null

  return (
    <Dialog open onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogHeader>
        <DialogTitle>Invite a member</DialogTitle>
        {!created && (
          <DialogDescription>
            Invite a partner, spouse, or accountant to collaborate on this household.
          </DialogDescription>
        )}
      </DialogHeader>

      {created ? (
        <>
          <DialogBody>
            <p className="mb-3">Send this link to your invitee. It works one time.</p>
            <div className="flex items-center gap-2">
              <Input
                id="invite-link-field"
                readOnly
                value={buildInviteUrl(created.token)}
                onFocus={(e) => e.currentTarget.select()}
                aria-label="Invite link"
              />
              <Button type="button" onClick={() => void copyLink()}>
                {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                Copy link
              </Button>
            </div>
            {err && (
              <p className="error mt-2" role="alert">
                {err}
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Done
            </Button>
          </DialogFooter>
        </>
      ) : (
        <form onSubmit={submit}>
          <DialogBody>
            <Label htmlFor="invite-email">
              Email (for your records)
              <Input
                id="invite-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="optional"
                autoComplete="off"
              />
            </Label>
            {err && (
              <p className="error mt-2" role="alert">
                {err}
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              Generate invite link
            </Button>
          </DialogFooter>
        </form>
      )}
    </Dialog>
  )
}
