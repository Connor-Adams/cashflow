import { useId, useState } from 'react';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter,
} from '@/components/ui/dialog';
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
  const selectId = useId();
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);

  async function submitCreate() {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const c = await onCreateContact(name);
      onChange(c.id);
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
      {/* eslint-disable-next-line jsx-a11y/label-has-associated-control */}
      <label htmlFor={selectId} className="sr-only">
        {`Counterparty for transaction ${txnId}`}
      </label>
      <NativeSelect
        id={selectId}
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
        onClick={() => setCreateOpen(true)}
      >
        <span className="sr-only">{`Add counterparty for transaction ${txnId}`}</span>
        <span aria-hidden="true">+ New</span>
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
