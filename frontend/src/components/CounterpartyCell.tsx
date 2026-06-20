import { useState } from 'react';
import { NativeSelect } from '@connor-adams/designsystem'
import { Button } from '@connor-adams/designsystem'
import { Input } from '@connor-adams/designsystem'
import { Dialog } from '@connor-adams/designsystem'
import type { Contact } from '../types/api';

export type CounterpartyCellProps = {
  value: number | null;
  contacts: Contact[];
  onChange: (id: number | null) => void;
  onCreateContact: (name: string) => Promise<Contact>;
  onError: (message: string) => void;
  txnId: number;
};

export function CounterpartyCell({
  value, contacts, onChange, onCreateContact, onError, txnId,
}: CounterpartyCellProps) {
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);

  async function submitCreate() {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const contact = await onCreateContact(name);
      onChange(contact.id);
      setCreateOpen(false);
      setNewName('');
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not create contact');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex items-center gap-1">
      <NativeSelect
        aria-label={`Counterparty for transaction ${txnId}`}
        value={value != null ? String(value) : ''}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        className="text-xs"
      >
        <option value="">No counterparty</option>
        {contacts.map((c) => (
          <option key={c.id} value={String(c.id)}>{c.name}</option>
        ))}
      </NativeSelect>
      <Button
        type="button" size="sm" variant="outline"
        aria-label={`Add new counterparty contact for transaction ${txnId}`}
        onClick={() => setCreateOpen(true)}
      >
        + New
      </Button>
      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title={<>New counterparty contact</>}
        footer={
          <>
            <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button" variant="primary"
              disabled={creating || !newName.trim()}
              onClick={() => void submitCreate()}
            >
              Create
            </Button>
          </>
        }
      >
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Name (e.g. John)"
          aria-label="New contact name"
        />
      </Dialog>
    </div>
  );
}
