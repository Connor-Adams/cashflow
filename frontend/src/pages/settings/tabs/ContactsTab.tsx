import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Button, Icon } from '@connor-adams/designsystem'
import { Card } from '@connor-adams/designsystem'
import { Dialog } from '@connor-adams/designsystem'
import { useConfirm } from '@/lib/ds-extras'
import { Input } from '@connor-adams/designsystem'
import { Label } from '@connor-adams/designsystem'
import { deleteReq, getJson, patchJson, postJson } from '../../../lib/api'
import { todayDateInputValue } from '../../../lib/dateInput'
import { formatMoney } from '../../../lib/formatMoney'
import type { Contact } from '../../../types/api'
import type { ReimbursementView } from '../../../types/reimbursement'

/**
 * #374 — Contact detail response shape from GET /api/contacts/:id.
 * Mirrors backend/src/routes/contacts.ts.
 */
type ContactDetail = Contact & {
  openReimbursements: {
    count: number
    byCurrency: Record<string, string>
    items: ReimbursementView[]
  }
  today: string
}

export function ContactsTab() {
  const [contacts, setContacts] = useState<Contact[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [renameTarget, setRenameTarget] = useState<Contact | null>(null)
  const [renameValue, setRenameValue] = useState('')
  // #375 — edit dialog carries the partner flag alongside the name so both
  // can be saved in one PATCH round-trip.
  const [renameIsPartner, setRenameIsPartner] = useState(false)
  const [renameSaving, setRenameSaving] = useState(false)
  // #375 — controlled state on the create form (FormData on checkboxes is
  // brittle: an unchecked box never appears in the payload, so we surface
  // the flag explicitly).
  const [createIsPartner, setCreateIsPartner] = useState(false)

  const confirm = useConfirm()
  const errorId = 'contacts-error'
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

  async function createContact(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = e.currentTarget
    const fd = new FormData(form)
    const name = String(fd.get('name') ?? '').trim()
    const notes = String(fd.get('notes') ?? '').trim()
    if (!name) return
    setErr(null)
    try {
      await postJson<Contact>('/api/contacts', {
        name,
        notes: notes || null,
        isPartner: createIsPartner,
      })
      form.reset()
      setCreateIsPartner(false)
      await loadContacts()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not create contact')
    }
  }

  function openRename(contact: Contact) {
    setRenameTarget(contact)
    setRenameValue(contact.name)
    setRenameIsPartner(contact.isPartner)
  }

  function closeRename() {
    setRenameTarget(null)
    setRenameValue('')
    setRenameIsPartner(false)
    setRenameSaving(false)
  }

  async function submitRename(e?: FormEvent<HTMLFormElement>) {
    if (e) e.preventDefault()
    if (!renameTarget) return
    const next = renameValue.trim()
    if (!next) return
    setRenameSaving(true)
    try {
      await patchJson<Contact>(`/api/contacts/${renameTarget.id}`, {
        name: next,
        isPartner: renameIsPartner,
      })
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
      description: `"${contact.name}" will be removed from your contacts ledger.`,
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

  return (
    <>
      <Card className="accountsFormCard">
        <form onSubmit={createContact}>
          <div className="accountsCardHeader">
            <div>
              <h2>Contacts ledger</h2>
              <p className="muted">Contacts track loans and reimbursements without giving login access.</p>
            </div>
          </div>
          <div className="mb-3 grid gap-3 grid-cols-[repeat(auto-fill,minmax(min(100%,180px),1fr))]">
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
          {/* #375 — partner flag drives the Partner Fairness inflow split. */}
          <Label htmlFor="settings-contact-is-partner" className="row">
            <input
              id="settings-contact-is-partner"
              type="checkbox"
              checked={createIsPartner}
              onChange={(e) => setCreateIsPartner(e.target.checked)}
            />
            <span>Partner</span>
          </Label>
          <Button type="submit">
            <Icon name="plus" aria-hidden="true" />
            Add contact
          </Button>
        </form>
      </Card>

      {err && (
        <span className="error" id={errorId} role="alert">
          {err}
        </span>
      )}
      <section className="accountsGrid mb-4">
        {contacts.map((contact) => (
          <ContactCard
            key={contact.id}
            contact={contact}
            onEdit={() => openRename(contact)}
            onDelete={() => void removeContact(contact)}
          />
        ))}
      </section>

      {renameTarget && (
        <Dialog
          open
          onClose={closeRename}
          title={<>Rename contact</>}
        >
          <form onSubmit={submitRename}>
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
            {/* #375 — let the user mark/unmark this Contact as the partner. */}
            <Label htmlFor="settings-rename-is-partner" className="row">
              <input
                id="settings-rename-is-partner"
                type="checkbox"
                checked={renameIsPartner}
                onChange={(e) => setRenameIsPartner(e.target.checked)}
              />
              <span>Partner</span>
            </Label>
            <div className="mt-2 flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={closeRename}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  renameSaving ||
                  !renameValue.trim() ||
                  (renameValue.trim() === renameTarget.name &&
                    renameIsPartner === renameTarget.isPartner)
                }
              >
                Save
              </Button>
            </div>
          </form>
        </Dialog>
      )}
      {confirm.dialog}
    </>
  )
}

/**
 * #374 — Per-contact card with a collapsible "Open reimbursements" section.
 * The aggregate ($X across Y items) loads lazily on first expand to keep the
 * initial /settings/contacts render cheap when the household has many contacts.
 */
function ContactCard({
  contact,
  onEdit,
  onDelete,
}: {
  contact: Contact
  onEdit: () => void
  onDelete: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [detail, setDetail] = useState<ContactDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function toggle() {
    const next = !expanded
    setExpanded(next)
    if (!next || detail) return
    setLoading(true)
    setErr(null)
    try {
      // Local calendar day so the open/overdue aggregate flips at the user's
      // midnight, not UTC's.
      const d = await getJson<ContactDetail>(
        `/api/contacts/${contact.id}?today=${todayDateInputValue()}`,
      )
      setDetail(d)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load reimbursements')
    } finally {
      setLoading(false)
    }
  }

  // Render the per-currency totals as "$60.00 CAD + $40.00 USD" so a
  // multi-currency household sees both at a glance.
  const summaryLine = detail
    ? formatOpenSummary(detail.openReimbursements)
    : null

  return (
    <Card className="accountCard">
      <div>
        <h3>
          {contact.name}
          {contact.isPartner && (
            <span className="muted ml-2 text-xs font-normal uppercase tracking-wide">
              Partner
            </span>
          )}
        </h3>
        {contact.notes && <p className="muted">{contact.notes}</p>}
      </div>
      <div className="row">
        <Button type="button" size="sm" variant="secondary" onClick={onEdit}>
          <Icon name="pencil" aria-hidden="true" />
          Edit
        </Button>
        <Button type="button" size="sm" variant="destructive" onClick={onDelete}>
          <Icon name="trash" aria-hidden="true" />
          Delete
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void toggle()}
          aria-expanded={expanded}
          aria-controls={`contact-${contact.id}-reimbursements`}
          title="Open reimbursements tied to this contact"
        >
          {expanded ? (
            <Icon name="chevron-down" aria-hidden="true" />
          ) : (
            <Icon name="chevron-right" aria-hidden="true" />
          )}
          Reimbursements
        </Button>
      </div>
      {expanded && (
        <div
          id={`contact-${contact.id}-reimbursements`}
          className="mt-3 border-t border-border pt-3 text-sm"
        >
          {loading && <p className="muted">Loading…</p>}
          {err && (
            <p className="error" role="alert">
              {err}
            </p>
          )}
          {!loading && !err && detail && (
            <>
              <p>
                <strong>Open reimbursements:</strong>{' '}
                {detail.openReimbursements.count > 0 ? (
                  <span>
                    {summaryLine} across {detail.openReimbursements.count} item
                    {detail.openReimbursements.count === 1 ? '' : 's'}
                  </span>
                ) : (
                  <span className="muted">none</span>
                )}
              </p>
              {detail.openReimbursements.items.length > 0 && (
                <ul className="mt-2 flex flex-col gap-1">
                  {detail.openReimbursements.items.map((item) => (
                    <li
                      key={item.id}
                      className="flex items-center justify-between gap-3 rounded-md border border-border/60 px-2 py-1"
                    >
                      <span className="flex flex-col">
                        <span>
                          {formatMoney(Number(item.amount), item.currency)}{' '}
                          <span className="muted text-xs">
                            ({item.effectiveStatus}
                            {item.dueDate ? ` · due ${item.dueDate}` : ''})
                          </span>
                        </span>
                        {item.transaction && (
                          <span className="muted text-xs">
                            {item.transaction.date} · {item.transaction.merchant}
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </Card>
  )
}

/**
 * Render "$60.00 CAD + $40.00 USD" from the per-currency aggregate. Empty
 * input returns "$0" so callers can render the summary line unconditionally.
 */
function formatOpenSummary(open: {
  byCurrency: Record<string, string>
}): string {
  const entries = Object.entries(open.byCurrency)
  if (entries.length === 0) return '$0'
  return entries
    .map(([currency, amount]) => formatMoney(Number(amount), currency))
    .join(' + ')
}
