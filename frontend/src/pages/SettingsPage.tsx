import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { deleteReq, getJson, patchJson, postJson } from '../lib/api'
import { useAuth } from '../lib/useAuth'
import type { Contact } from '../types/api'

export function SettingsPage() {
  const auth = useAuth()
  const [contacts, setContacts] = useState<Contact[]>([])
  const [invite, setInvite] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

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

  async function renameContact(contact: Contact) {
    const name = prompt('Contact name', contact.name)
    if (name == null || !name.trim()) return
    try {
      await patchJson<Contact>(`/api/contacts/${contact.id}`, { name: name.trim() })
      await loadContacts()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not update contact')
    }
  }

  async function removeContact(contact: Contact) {
    if (!confirm(`Delete contact "${contact.name}"?`)) return
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
    <div className="page">
      <div className="accountsHeader">
        <h1>Settings</h1>
        <p className="muted">
          {auth.user?.household?.name} · {auth.user?.email}
          {auth.user?.globalRole === 'superadmin' ? ' · God mode' : ''}
        </p>
      </div>

      <section className="card accountsFormCard">
        <div className="accountsCardHeader">
          <div>
            <h2>Partner invite</h2>
            <p className="muted">Invite links let another user join shared household reporting.</p>
          </div>
          <button type="button" onClick={createInvite}>
            Create invite
          </button>
        </div>
        {inviteUrl && (
          <input readOnly value={inviteUrl} onFocus={(e) => e.currentTarget.select()} />
        )}
      </section>

      <form className="card accountsFormCard" onSubmit={createContact}>
        <div className="accountsCardHeader">
          <div>
            <h2>Contacts ledger</h2>
            <p className="muted">Contacts track loans and reimbursements without giving login access.</p>
          </div>
        </div>
        <div className="formGrid">
          <label>
            Name
            <input name="name" required />
          </label>
          <label>
            Notes
            <input name="notes" />
          </label>
        </div>
        <button type="submit">Add contact</button>
      </form>

      {err && <span className="error">{err}</span>}
      <section className="accountsGrid">
        {contacts.map((contact) => (
          <article className="card accountCard" key={contact.id}>
            <div>
              <h3>{contact.name}</h3>
              {contact.notes && <p className="muted">{contact.notes}</p>}
            </div>
            <div className="row">
              <button type="button" onClick={() => void renameContact(contact)}>
                Edit
              </button>
              <button type="button" onClick={() => void removeContact(contact)}>
                Delete
              </button>
            </div>
          </article>
        ))}
      </section>
    </div>
  )
}
