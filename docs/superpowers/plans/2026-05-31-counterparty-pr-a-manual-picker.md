# Counterparty PR A — Manual per-transaction Contact picker (with inline create) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user set/clear a transaction's canonical counterparty Contact (`counterpartyContactId`) from the transactions table, including creating a new Contact inline.

**Architecture:** The DB column (`transactions.counterparty_contact_id`) and model field already exist; the promote endpoints already write it. This PR opens the **manual write path**: (1) backend adds `counterpartyContactId` to the transaction PATCH allow-list with household-scoped FK validation (mirroring `ownershipContactId`); (2) a new self-contained `CounterpartyCell` component renders a native-select of existing contacts plus a "+ New" button that opens a create dialog; (3) `TransactionRow` holds the picker state and flows it through the existing `onSave → patchJson → load()` save path; the page provides a `createContact` handler that POSTs to the existing `/api/contacts` and adds the contact to the in-memory pool. Direction ("to/from") already renders from the amount sign in the existing badge — no new field, no migration.

**Tech Stack:** Express + Sequelize (backend), `node:test` + supertest (backend tests), React + `@/components/ui/{native-select,dialog,input,button}` (frontend), vitest + @testing-library/react (frontend tests).

**Spine note:** Counterparty primitive. No new table, no new status machine. Not a spine change.

---

## File Structure

- Modify: `backend/src/routes/transactions.ts` — add `counterpartyContactId` to `PATCHABLE_KEYS` (line 345) and a validation branch in `applyPatchBody` (after line 413).
- Modify: `backend/test/integration/transactions.test.ts` — new PATCH cases mirroring the `ownershipContactId` cases at lines 481–537.
- Create: `frontend/src/components/CounterpartyCell.tsx` — self-contained select + inline-create dialog.
- Create: `frontend/src/components/CounterpartyCell.test.tsx` — unit tests (pure; mocks `onChange`/`onCreateContact`).
- Modify: `frontend/src/pages/TransactionsPage.tsx` — page `createContact` handler + thread `onCreateContact` down; `TransactionRow` holds picker state, renders `CounterpartyCell`, includes the field in `isDirty` + the Save patch.

No new backend files; no migration.

---

## Task 1: Backend — make `counterpartyContactId` patchable with household-scoped validation

**Files:**
- Modify: `backend/src/routes/transactions.ts:345` (PATCHABLE_KEYS) and `:413` (applyPatchBody branch)
- Test: `backend/test/integration/transactions.test.ts`

The existing `ownershipContactId` branch (`applyPatchBody`, lines 399–413) is the exact pattern to mirror, except `counterpartyContactId` has **no** coupling to `ownershipType` (independent — never force-nulled, never required).

- [ ] **Step 1: Write the failing tests**

Add to `backend/test/integration/transactions.test.ts` next to the `ownershipContactId` tests (after the block ending ~line 537). Reuses the file's helpers (`createTxn`, `agentA`, `contactAId`, `contactBId`, `householdAId`, `accountAId`):

```ts
test('PATCH /:id: counterpartyContactId links a household contact', async () => {
  const id = await createTxn({
    householdId: householdAId, accountId: accountAId, date: '2026-01-05', amount: -50,
  });
  const res = await agentA.patch(`/api/transactions/${id}`).send({
    counterpartyContactId: contactAId,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.counterpartyContactId, contactAId);
});

test('PATCH /:id: counterpartyContactId=null clears the link', async () => {
  const id = await createTxn({
    householdId: householdAId, accountId: accountAId, date: '2026-01-05', amount: -50,
  });
  await agentA.patch(`/api/transactions/${id}`).send({ counterpartyContactId: contactAId });
  const res = await agentA.patch(`/api/transactions/${id}`).send({ counterpartyContactId: null });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.counterpartyContactId, null);
});

test('PATCH /:id: cross-household counterpartyContactId throws 400', async () => {
  const id = await createTxn({
    householdId: householdAId, accountId: accountAId, date: '2026-01-05', amount: -50,
  });
  const res = await agentA.patch(`/api/transactions/${id}`).send({
    counterpartyContactId: contactBId,
  });
  assert.equal(res.status, 400);
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `cd backend && yarn test:integration test/integration/transactions.test.ts`
Expected: the link test FAILS (field ignored → body stays `null`/`undefined`); the cross-household test FAILS (200, not 400).

- [ ] **Step 3: Add the field to the allow-list**

In `backend/src/routes/transactions.ts`, add `'counterpartyContactId'` to `PATCHABLE_KEYS` (lines 345–356), after `'ownershipContactId'`:

```ts
  'ownershipType',
  'ownershipContactId',
  'counterpartyContactId',
  'status',
] as const;
```

- [ ] **Step 4: Add the validation branch**

In `applyPatchBody`, add after the `ownershipContactId` branch (after line 413, before `else if (k === 'status')`):

```ts
      } else if (k === 'counterpartyContactId') {
        if (b[k] == null || b[k] === '') {
          txn.set('counterpartyContactId', null);
        } else {
          const contactId = Number(b[k]);
          const contact = await Contact.findOne({
            where: { id: contactId, householdId: household.id },
          });
          if (!contact) {
            const err = new Error(
              'counterpartyContactId must reference a household contact',
            ) as Error & { status?: number };
            err.status = 400;
            throw err;
          }
          txn.set('counterpartyContactId', contact.id);
        }
```

Do **not** add `ownershipType`-style coupling — this field is set independently.

- [ ] **Step 5: Run the tests, verify they pass**

Run: `cd backend && yarn test:integration test/integration/transactions.test.ts`
Expected: the three new tests PASS; pre-existing tests still PASS. The link test passing confirms `serializeTransaction` already returns `counterpartyContactId`; if it shows `undefined`, add `counterpartyContactId: txn.counterpartyContactId` to `serializeTransaction` and re-run.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/transactions.ts backend/test/integration/transactions.test.ts
git commit -m "feat(counterparty): allow setting counterpartyContactId via transaction PATCH"
```

---

## Task 2: Frontend — `CounterpartyCell` component + unit tests

**Files:**
- Create: `frontend/src/components/CounterpartyCell.tsx`
- Test: `frontend/src/components/CounterpartyCell.test.tsx`

Self-contained and presentational: it renders a contact `NativeSelect` + a "+ New" button that opens a create `Dialog`. It does NOT call the API directly — creation is delegated to the `onCreateContact` prop (the page owns the contacts pool + the POST). This keeps the component pure and the tests free of api/fixture mocking.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/components/CounterpartyCell.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CounterpartyCell } from './CounterpartyCell';

const contacts = [
  { id: 7, householdId: 1, name: 'John', notes: null, isPartner: false },
  { id: 8, householdId: 1, name: 'Mom', notes: null, isPartner: false },
] as never;

describe('CounterpartyCell', () => {
  it('emits the chosen contact id', () => {
    const onChange = vi.fn();
    render(
      <CounterpartyCell value={null} contacts={contacts} onChange={onChange}
        onCreateContact={vi.fn()} onError={vi.fn()} txnId={1} />,
    );
    fireEvent.change(screen.getByLabelText(/counterparty for transaction 1/i), {
      target: { value: '7' },
    });
    expect(onChange).toHaveBeenCalledWith(7);
  });

  it('emits null when cleared', () => {
    const onChange = vi.fn();
    render(
      <CounterpartyCell value={7} contacts={contacts} onChange={onChange}
        onCreateContact={vi.fn()} onError={vi.fn()} txnId={1} />,
    );
    fireEvent.change(screen.getByLabelText(/counterparty for transaction 1/i), {
      target: { value: '' },
    });
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('creates a contact inline and selects it', async () => {
    const onChange = vi.fn();
    const onCreateContact = vi.fn().mockResolvedValue({
      id: 99, householdId: 1, name: 'Zoe', notes: null, isPartner: false,
    });
    render(
      <CounterpartyCell value={null} contacts={contacts} onChange={onChange}
        onCreateContact={onCreateContact} onError={vi.fn()} txnId={1} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /add counterparty for transaction 1/i }));
    fireEvent.change(screen.getByLabelText(/new contact name/i), { target: { value: 'Zoe' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));
    await waitFor(() => expect(onCreateContact).toHaveBeenCalledWith('Zoe'));
    expect(onChange).toHaveBeenCalledWith(99);
  });
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `cd frontend && yarn vitest run src/components/CounterpartyCell.test.tsx`
Expected: FAIL — module `./CounterpartyCell` does not exist.

- [ ] **Step 3: Implement the component**

Create `frontend/src/components/CounterpartyCell.tsx`:

```tsx
import { useState } from 'react';
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
      <NativeSelect
        value={value != null ? String(value) : ''}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        aria-label={`Counterparty for transaction ${txnId}`}
        className="text-xs"
      >
        <NativeSelectOption value="">No counterparty</NativeSelectOption>
        {contacts.map((c) => (
          <NativeSelectOption key={c.id} value={c.id}>{c.name}</NativeSelectOption>
        ))}
      </NativeSelect>
      <Button
        type="button" size="sm" variant="outline"
        onClick={() => setCreateOpen(true)}
        aria-label={`Add counterparty for transaction ${txnId}`}
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
```

(If `Input` is a default export in this repo, adjust the import accordingly — check `frontend/src/components/ui/input.tsx`'s export style before running.)

- [ ] **Step 4: Run the tests, verify they pass**

Run: `cd frontend && yarn vitest run src/components/CounterpartyCell.test.tsx`
Expected: all three PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/CounterpartyCell.tsx frontend/src/components/CounterpartyCell.test.tsx
git commit -m "feat(counterparty): CounterpartyCell picker with inline contact create"
```

---

## Task 3: Frontend — wire `CounterpartyCell` into the transactions table

**Files:**
- Modify: `frontend/src/pages/TransactionsPage.tsx`

- [ ] **Step 1: Add the page `createContact` handler**

In `TransactionsPage` (near `saveRow`, ~line 366), add a handler that POSTs to the existing contacts endpoint and adds the result to the in-memory `contacts` pool (so the picker shows it immediately). `postJson` and the `contacts`/`setContacts` state already exist on this page.

```tsx
  async function createContact(name: string): Promise<Contact> {
    const c = await postJson<Contact>('/api/contacts', { name });
    setContacts((prev) =>
      [...prev, c].sort((a, b) => a.name.localeCompare(b.name)),
    );
    return c;
  }
```

- [ ] **Step 2: Thread `onCreateContact` to the row**

Where `TransactionRow` is rendered (~line 1815, alongside `onSave={saveRow}` and `contacts={contacts}`), pass `onCreateContact={createContact}`. Add `onCreateContact: (name: string) => Promise<Contact>` to the `TransactionRow` props type (the same interface that declares `onSave` at ~line 1938).

- [ ] **Step 3: Hold picker state in `TransactionRow`**

Next to the ownership state (~lines 1970–1975), add:

```tsx
  const [counterpartyContactId, setCounterpartyContactId] = useState<number | null>(
    t.counterpartyContactId ?? null,
  );
```

- [ ] **Step 4: Render `CounterpartyCell` in the merchant cell**

Import it at the top of the file: `import { CounterpartyCell } from '../components/CounterpartyCell'`. In the merchant `<TableCell>`, immediately after the existing read-only counterparty badge block (ends ~line 2083), render the editable cell (the badge stays as the at-a-glance "from/to <name>" line; the cell does the editing):

```tsx
          <CounterpartyCell
            value={counterpartyContactId}
            contacts={contacts}
            onChange={setCounterpartyContactId}
            onCreateContact={onCreateContact}
            onError={onError}
            txnId={t.id}
          />
```

- [ ] **Step 5: Include the field in `isDirty` and the Save patch**

Find the `const isDirty =` expression in `TransactionRow` and add this term so the Save button enables on change:

```tsx
    || (t.counterpartyContactId ?? null) !== counterpartyContactId
```

In the Save button's `onSave` patch object (~lines 2365–2377), add:

```tsx
                counterpartyContactId,
```

- [ ] **Step 6: Gate — typecheck, lint, full frontend tests**

Run: `cd frontend && yarn tsc --noEmit`
Run: `cd frontend && yarn vitest run src/components/CounterpartyCell.test.tsx`
Run: `cd frontend && yarn lint` (if the repo defines it)
Expected: no type errors; tests PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/TransactionsPage.tsx
git commit -m "feat(counterparty): wire CounterpartyCell into the transactions table row"
```

---

## Task 4: Verify in the app + open PR

- [ ] **Step 1: Smoke test the real app**

Launch the app (use the `/run` skill or the repo dev command). On the transactions page:
1. Pick an existing contact in a row's counterparty select → Save → the "to/from <name>" badge updates; reload → value persisted.
2. Click "+ New", create "Zoe" → the row's select shows Zoe selected → Save → reload → persisted.
3. Pick "No counterparty" → Save → cleared.

- [ ] **Step 2: Full test gate**

Run: `cd backend && yarn test:integration test/integration/transactions.test.ts`
Run: `cd frontend && yarn vitest run src/components/CounterpartyCell.test.tsx && yarn tsc --noEmit`
Expected: all PASS, no type errors.

- [ ] **Step 3: Push + PR with auto-merge (merge commit, no squash)**

```bash
git push -u origin HEAD
gh pr create --title "feat(counterparty): manual per-transaction Contact picker w/ inline create (PR A)" \
  --body "Opens the manual write path for the canonical counterparty link (counterpartyContactId): household-scoped PATCH validation + a CounterpartyCell picker (native-select of contacts + inline create dialog) wired into the transactions row. No migration. Spec: docs/superpowers/specs/2026-05-31-canonical-counterparty-on-transactions-design.md" \
  --base main
gh pr merge --auto --merge
```

(Per repo policy: auto-merge with a merge commit, never squash. Enable `allow_auto_merge` first if the API rejects `--auto`.)

---

## Self-review (completed during planning)

- **Spec coverage:** Implements spec §"PR A — Manual per-transaction picker" in full, including the spec's inline-create ("Create '<name>' inline"). PR B (import auto-link) and PR C (backfill) are separate plans.
- **Inline create:** Confirmed wanted. Built on existing `dialog`+`input`+`button`+`native-select` primitives (no combobox/cmdk exists in the repo). Creation delegated to the page via `onCreateContact` so `CounterpartyCell` stays pure and unit-testable.
- **Types:** `counterpartyContactId` is `number | null` on the model, the frontend `Transaction` type, the row state, the `CounterpartyCell.value`/`onChange`, and the Save patch — consistent end to end. The select coerces its string event value to `number | null` at the boundary.
- **Isolation:** Editable picker extracted to `CounterpartyCell` (one file, one responsibility) rather than inlined into the 2400-line `TransactionsPage`, per the design-for-isolation guidance.
- **No placeholders:** every code step shows exact code. The one note (Task 2 Step 3, `Input` export style) is a 1-line check, not a logic gap.
