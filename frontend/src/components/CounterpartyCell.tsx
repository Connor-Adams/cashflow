import { useState } from 'react';
import { NativeSelect, NativeSelectOption } from '@cashflow/ui';
import { Button } from '@cashflow/ui';
import { Input } from '@cashflow/ui';
import {
  Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter,
} from '@cashflow/ui';
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
        <NativeSelectOption value="">No counterparty</NativeSelectOption>
        {contacts.map((c) => (
          <NativeSelectOption key={c.id} value={String(c.id)}>{c.name}</NativeSelectOption>
        ))}
      </NativeSelect>
      <Button
        type="button" size="sm" variant="outline"
        aria-label={`Add new counterparty contact for transaction ${txnId}`}
        onClick={() => setCreateOpen(true)}
      >
        + New
      </Button>
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogHeader><DialogTitle>New counterparty contact</DialogTitle></DialogHeader>
        <DialogBody>
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Name (e.g. John)"
            aria-label="New contact name"
          />
        </DialogBody>
        <DialogFooter>
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
        </DialogFooter>
      </Dialog>
    </div>
  );
}
