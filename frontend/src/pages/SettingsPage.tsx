import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Edit3, Link2, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  useConfirm,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PageHeader } from '@/components/ui/page-header'
import { deleteReq, getJson, patchJson, postJson } from '../lib/api'
import { layoutWidthOptions, useLayoutWidth } from '../lib/layoutWidth'
import { useAuth } from '../lib/useAuth'
import type { Contact } from '../types/api'

export function SettingsPage() {
  const auth = useAuth()
  const [layoutWidth, setLayoutWidth] = useLayoutWidth()
  const [contacts, setContacts] = useState<Contact[]>([])
  const [invite, setInvite] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [renameTarget, setRenameTarget] = useState<Contact | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renameSaving, setRenameSaving] = useState(false)
  const confirm = useConfirm()
  const errorId = 'settings-error'
  const hasError = Boolean(err)

  const loadContacts = useCallback(async () => {
    try {
      setContacts(await getJson<Contact[]>('/api/contacts'))
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load contacts')
    }
  }, [])

  useEffect(() => {
    void loadContacts()
  }, [loadContacts])

  async function createInvite() {
    setErr(null)
    try {
      const data = await postJson<{ token: string }>('/api/auth/invites')
      setInvite(data.token)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not create invite')
    }
  }

  async function createContact(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = e.currentTarget
    const fd = new FormData(form)
    const name = String(fd.get('name') ?? '').trim()
    const notes = String(fd.get('notes') ?? '').trim()
    if (!name) return
    setErr(null)
    try {
      await postJson<Contact>('/api/contacts', { name, notes: notes || null })
      form.reset()
      await loadContacts()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not create contact')
    }
  }

  function openRename(contact: Contact) {
    setRenameTarget(contact)
    setRenameValue(contact.name)
  }

  function closeRename() {
    setRenameTarget(null)
    setRenameValue('')
    setRenameSaving(false)
  }

  async function submitRename(e?: FormEvent<HTMLFormElement>) {
    if (e) e.preventDefault()
    if (!renameTarget) return
    const next = renameValue.trim()
    if (!next) return
    setRenameSaving(true)
    try {
      await patchJson<Contact>(`/api/contacts/${renameTarget.id}`, { name: next })
      closeRename()
      await loadContacts()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not update contact')
      setRenameSaving(false)
    }
  }

  async function removeContact(contact: Contact) {
    const ok = await confirm({
      title: 'Delete contact?',
      description: `“${contact.name}” will be removed from your contacts ledger.`,
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    try {
      await deleteReq(`/api/contacts/${contact.id}`)
      await loadContacts()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not delete contact')
    }
  }

  const inviteUrl = invite
    ? `${window.location.origin}${window.location.pathname}?invite=${encodeURIComponent(invite)}`
    : null

  return (
    <>
    <div className="page">
      <PageHeader
        title="Settings"
        description={
          <>
            {auth.user?.household?.name} · {auth.user?.email}
            {auth.user?.globalRole === 'superadmin' ? ' · God mode' : ''}
          </>
        }
      />

      <Card className="settingsDisplayCard">
        <div className="accountsCardHeader">
          <div>
            <h2>Display width</h2>
            <p className="muted">Choose how much horizontal space the app can use on this browser.</p>
          </div>
        </div>
        <div className="settingsWidthOptions" role="radiogroup" aria-label="Display width">
          {layoutWidthOptions.map((option) => (
            <label className="settingsWidthOption" key={option.value}>
              <input
                type="radio"
                name="layoutWidth"
                value={option.value}
                checked={layoutWidth === option.value}
                onChange={() => setLayoutWidth(option.value)}
              />
              <span>
                <strong>{option.label}</strong>
                <small>{option.description}</small>
              </span>
            </label>
          ))}
        </div>
      </Card>

      <Card className="accountsFormCard">
        <div className="accountsCardHeader">
          <div>
            <h2>Partner invite</h2>
            <p className="muted">Invite links let another user join shared household reporting.</p>
          </div>
          <Button type="button" onClick={createInvite}>
            <Link2 aria-hidden="true" />
            Create invite
          </Button>
        </div>
        {inviteUrl && (
          <Input readOnly value={inviteUrl} onFocus={(e) => e.currentTarget.select()} />
        )}
      </Card>

      <Card className="accountsFormCard">
        <form onSubmit={createContact}>
          <div className="accountsCardHeader">
            <div>
              <h2>Contacts ledger</h2>
              <p className="muted">Contacts track loans and reimbursements without giving login access.</p>
            </div>
          </div>
          <div className="formGrid">
            <Label htmlFor="settings-contact-name">
              Name
              <Input
                id="settings-contact-name"
                name="name"
                required
                aria-invalid={hasError || undefined}
                aria-describedby={hasError ? errorId : undefined}
              />
            </Label>
            <Label htmlFor="settings-contact-notes">
              Notes
              <Input id="settings-contact-notes" name="notes" />
            </Label>
          </div>
          <Button type="submit">
            <Plus aria-hidden="true" />
            Add contact
          </Button>
        </form>
      </Card>

      {err && (
        <span className="error" id={errorId} role="alert">
          {err}
        </span>
      )}
      <section className="accountsGrid">
        {contacts.map((contact) => (
          <Card className="accountCard" key={contact.id}>
            <div>
              <h3>{contact.name}</h3>
              {contact.notes && <p className="muted">{contact.notes}</p>}
            </div>
            <div className="row">
              <Button type="button" size="sm" variant="secondary" onClick={() => openRename(contact)}>
                <Edit3 aria-hidden="true" />
                Edit
              </Button>
              <Button type="button" size="sm" variant="destructive" onClick={() => void removeContact(contact)}>
                <Trash2 aria-hidden="true" />
                Delete
              </Button>
            </div>
          </Card>
        ))}
      </section>
    </div>
    {renameTarget && (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) closeRename()
        }}
      >
        <DialogHeader>
          <DialogTitle>Rename contact</DialogTitle>
        </DialogHeader>
        <form onSubmit={submitRename}>
          <DialogBody>
            <Label htmlFor="settings-rename-name">
              Contact name
              <Input
                id="settings-rename-name"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                required
                autoComplete="off"
              />
            </Label>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeRename}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={renameSaving || !renameValue.trim() || renameValue.trim() === renameTarget.name}
            >
              Save
            </Button>
          </DialogFooter>
        </form>
      </Dialog>
    )}
    {confirm.dialog}
    </>
  )
}
